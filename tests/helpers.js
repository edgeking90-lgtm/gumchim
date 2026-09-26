'use strict';

// fake-indexeddb/auto sets global.indexedDB / global.IDBKeyRange etc. so that
// gumchimDb.js (which just uses the ambient indexedDB/IDBKeyRange like real
// browser code does) works unmodified under Node.
require('fake-indexeddb/auto');

// gumchimDb.js is a UMD-style module: `(function(global){ ... global.GumchimDb = {...} })(globalThis)`.
// Just requiring the file attaches GumchimDb onto globalThis; grab it from there.
require('../gumchimDb.js');
const GumchimDb = globalThis.GumchimDb;

// 실기기는 항상 같은 DB 이름(GumchimDb.DB_NAME) 하나만 쓰므로, 테스트도 일부러
// 같은 이름을 재사용해서 진짜 마이그레이션 경로(oldVersion 감지 등)를 그대로 탄다.
// 대신 매 테스트 시작 전 완전히 지우고 시작해서 테스트끼리 절대 안 섞이게 한다.
function resetRealDatabase(){
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(GumchimDb.DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject(e.target.error);
    req.onblocked = () => resolve();
  });
}

// v6(회차 개념이 생기기 전) 스키마를 raw indexedDB로 그대로 재현해서 심는다 —
// gumchimDb.js를 거치지 않는다(그러면 애초에 v7로 만들어져서 마이그레이션을
// 테스트할 수 없다). 실기기에 있던 것과 최대한 같은 모양으로 만든다.
function seedLegacyV6Database({ entries = [], photos = [], preset = null } = {}){
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(GumchimDb.DB_NAME, 6);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      db.createObjectStore('presets', { keyPath: 'id' });
      const entryStore = db.createObjectStore('entries', { keyPath: 'key' });
      entryStore.createIndex('by_time', 'time');
      entryStore.createIndex('by_preset', 'presetId');
      db.createObjectStore('photos', { keyPath: 'key' });
      const omStore = db.createObjectStore('outputMappings', { keyPath: 'id' });
      omStore.createIndex('by_preset_mapping', 'presetId');
      db.createObjectStore('originalFiles', { keyPath: 'key' });
    };
    req.onsuccess = (e) => {
      const db = e.target.result;
      const tx = db.transaction(['presets', 'entries', 'photos'], 'readwrite');
      if(preset) tx.objectStore('presets').put(preset);
      entries.forEach(rec => tx.objectStore('entries').add(rec));
      photos.forEach(p => tx.objectStore('photos').add(p));
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = (ev) => reject(ev.target.error);
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

// 실기기와 같은 모양(320건: 202동 160세대 x 냉수/온수)의 v6 레거시 entries를 만든다.
// key는 옛 3-토막 포맷(presetId_호수_종류) — 지금 gumchimDb.js의 dbKeyFor는 이미
// 4-토막이라 여기서는 절대 그 함수를 쓰지 않고 옛 포맷을 그대로 손으로 재현한다.
function buildLegacyV6Entries(presetId){
  const preset = GumchimDb.buildBuiltin202Preset();
  const entries = [];
  let i = 0;
  preset.units.forEach(u => {
    preset.meterTypes.forEach(type => {
      i += 1;
      const hour = String(10 + (i % 8)).padStart(2, '0');
      entries.push({
        key: presetId + '_' + u.ho + '_' + type,
        presetId,
        ho: u.ho,
        type,
        value: String(1000 + i),
        time: '2026-09-07T' + hour + ':00:00.000Z',
        needsReview: i % 37 === 0, // 몇 건은 확인필요 케이스로도 섞어서 필드 보존을 같이 검증
        reviewReasons: i % 37 === 0 ? ['negative_usage'] : []
      });
    });
  });
  return { preset, entries };
}

module.exports = { GumchimDb, resetRealDatabase, seedLegacyV6Database, buildLegacyV6Entries };
