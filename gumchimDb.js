/**
 * Gumchim IndexedDB 레이어 (v7).
 *
 * index.html의 인라인 DB 레이어를 그대로 옮긴 것 — xlsx 관련 로직을
 * gumchimXlsxExport.js/gumchimXlsxPatch.js로 분리해둔 것과 같은 이유다:
 * Node(fake-indexeddb)로 마이그레이션을 자동 테스트할 수 있게 하기 위함.
 * index.html은 이 파일을 <script>로 먼저 불러온 뒤 GumchimDb.* 를 그대로 쓴다.
 *
 * v7에서 추가된 것: "회차(period)" 개념.
 *   - periods: 한 현장(presetId) 안의 검침 회차. id는 'YYYY-MM' 라벨로부터
 *     결정적으로 계산된다(presetId와 같은 철학 — 같은 달을 두 번 만들어도 안 늘어남).
 *   - entries의 유일키는 이제 presetId+periodId+호수+종류 네 개로 구성된다.
 *   - preset.activePeriodId: 지금 실제로 신규 검침이 들어가는 회차. 화면에서
 *     과거 회차를 "조회"하는 것과는 완전히 별개 개념이다 — 조회 상태는 이 DB
 *     레이어가 아니라 index.html의 화면 상태(selectedPeriodId)가 갖는다.
 *
 * 원칙(향후에도 지킬 것): entries.periodId는 항상 "그 값을 확정할 때의
 * activePeriodId"를 그대로 박아 넣는 명시적 필드다. entry.time(확정 시각)에서
 * 월을 추론해서 periodId를 정하지 않는다 — 10월 검침값을 11월 1일에 보정
 * 저장해도 periodId는 여전히 2026-10이어야 한다.
 */
(function(global){
  'use strict';

  const DB_NAME = 'gumchim-db';
  const DB_VERSION = 7;
  const STORE = 'entries';
  const PRESET_STORE = 'presets';
  const PHOTO_STORE = 'photos';
  const OUTPUT_MAPPING_STORE = 'outputMappings';
  const ORIGINAL_FILE_STORE = 'originalFiles';
  const PERIOD_STORE = 'periods';
  const BUILTIN_202_PRESET_ID = 'builtin-202-water';

  // v6까지(회차 개념이 생기기 전) 쌓인 기록은 전부 이 실기기에서 실제로 확인된
  // 2026년 9월 검침분이다. "언제 확정됐는지 시각에서 월을 추론"하는 일반 규칙이
  // 아니라, 이번 1회성 마이그레이션에서만 쓰는 명시적 상수다.
  const LEGACY_V6_MIGRATION_PERIOD_LABEL = '2026-09';

  let db = null;

  // ---------------------------------------------------------------------
  // 순수 함수 (IndexedDB 없이 테스트 가능)
  // ---------------------------------------------------------------------

  // 기존 index.html의 slugify()와 byte-identical하게 유지해야 한다 — 실기기에
  // 이미 저장된 presetId(예: site-202동-냉수-온수)가 이 함수로 만들어졌기 때문에,
  // 조금이라도 다르면 기존 현장과 다른 id가 계산되어 데이터가 갈라진다.
  function slugify(s){
    return (s || '').toString().trim().replace(/[^a-zA-Z0-9가-힣]+/g, '-').replace(/^-+|-+$/g, '');
  }

  // 같은 PC 구조 파일(같은 동 + 같은 검침항목)을 다시 불러오면 새 현장이 아니라
  // 같은 현장을 갱신하도록 결정적 id를 쓴다. (진행 기록을 잃지 않기 위함)
  function presetIdFromStructure(s){
    return 'site-' + slugify(s.dong) + '-' + slugify((s.meterTypes || []).join('-'));
  }

  // 'YYYY-MM' 형식만 허용 — 자유 회차("10월 1차")는 이번 범위에서 제외.
  function isValidPeriodLabel(label){
    return /^\d{4}-\d{2}$/.test(String(label || ''));
  }

  // 같은 presetId + label을 다시 만들어도 같은 회차로 합쳐지도록 결정적 id를 쓴다.
  function periodIdFor(presetId, label){
    return presetId + '__period-' + label;
  }

  function dbKeyFor(presetId, periodId, ho, type){
    return presetId + '_' + periodId + '_' + ho + '_' + type;
  }

  // label 'YYYY-MM'끼리는 문자열 비교만으로 시간 순서가 정확하다(둘 다 고정폭).
  function comparePeriodLabels(a, b){
    return a < b ? -1 : (a > b ? 1 : 0);
  }

  // 같은 preset에 속한 회차 목록에서, currentLabel보다 "바로 이전"인 회차를 찾는다.
  // 없으면 null(첫 회차이거나, 그보다 이전 회차가 아직 없는 경우).
  function findPreviousPeriod(periods, currentLabel){
    let best = null;
    for(const p of (periods || [])){
      if(comparePeriodLabels(p.label, currentLabel) < 0){
        if(!best || comparePeriodLabels(p.label, best.label) > 0) best = p;
      }
    }
    return best;
  }

  // "새 회차" 화면에서 기본값으로 제안할 다음 달 라벨.
  function nextPeriodLabel(label){
    const m = /^(\d{4})-(\d{2})$/.exec(label);
    if(!m) return label;
    let year = parseInt(m[1], 10);
    let month = parseInt(m[2], 10) + 1;
    if(month > 12){ month = 1; year += 1; }
    return year + '-' + String(month).padStart(2, '0');
  }

  // 기존 202동 하드코딩과 완전히 동일한 순서로 만든 내장 프리셋.
  // (unit-major, meter-type-minor로 펼쳤을 때 예전 buildSequence()와 byte-equivalent —
  //  이 동등성은 별도 회귀 테스트로 검증되어 있다.)
  function buildBuiltin202Preset(){
    const units = [];
    // 임시 샘플 데이터 — 동선/이전값 비교 UI를 실기에서 확인해보기 위한 테스트용.
    // 2008/2007/2006/2005호에만 넣어두고 나머지는 비워둬서, history가 없을 때
    // "비교 데이터 없음"으로 정상 처리되는지도 같이 확인할 수 있게 했다.
    const sampleHistory = {
      '2008': { '냉수': { previousReading: 980,  averageUsage: 15, sampleCount: 6 },
                '온수': { previousReading: 640,  averageUsage: 10, sampleCount: 6 } },
      '2007': { '냉수': { previousReading: 1100, averageUsage: 22, sampleCount: 6 },
                '온수': { previousReading: 720,  averageUsage: 18, sampleCount: 6 } },
      '2006': { '냉수': { previousReading: 1450, averageUsage: 25, sampleCount: 6 },
                '온수': { previousReading: 1206, averageUsage: 28, sampleCount: 6 } },
      '2005': { '냉수': { previousReading: 890,  averageUsage: 12, sampleCount: 5 },
                '온수': { previousReading: 560,  averageUsage: 9,  sampleCount: 5 } }
    };
    for(let floor=20; floor>=1; floor--){
      for(let unit=8; unit>=1; unit--){
        const ho = String(floor) + String(unit).padStart(2, '0');
        const u = { ho, floor: floor, unit: unit };
        if(sampleHistory[ho]) u.history = sampleHistory[ho];
        units.push(u);
      }
    }
    return {
      id: BUILTIN_202_PRESET_ID,
      name: '202동 수도',
      dong: '202동',
      meterTypes: ['냉수', '온수'],
      floorOrder: 'desc',
      unitOrderWithinFloor: 'desc',
      units: units,
      builtin: true,
      createdAt: new Date().toISOString()
    };
  }

  // ---------------------------------------------------------------------
  // IndexedDB 오픈 + 마이그레이션
  // ---------------------------------------------------------------------

  function openDB(){
    return new Promise((resolve, reject) => {
      const req = global.indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const _db = e.target.result;
        const tx = e.target.transaction;
        const oldVersion = e.oldVersion;

        // presets 스토어 — 없으면 새로 만들고, 내장 202동 프리셋을 반드시 보장한다.
        let presetStore;
        if(!_db.objectStoreNames.contains(PRESET_STORE)){
          presetStore = _db.createObjectStore(PRESET_STORE, { keyPath: 'id' });
        } else {
          presetStore = tx.objectStore(PRESET_STORE);
        }
        presetStore.get(BUILTIN_202_PRESET_ID).onsuccess = (ev) => {
          if(!ev.target.result){
            presetStore.add(buildBuiltin202Preset());
          }
        };

        // periods 스토어 — v7 신규.
        let periodStore;
        if(!_db.objectStoreNames.contains(PERIOD_STORE)){
          periodStore = _db.createObjectStore(PERIOD_STORE, { keyPath: 'id' });
          periodStore.createIndex('by_preset', 'presetId');
        } else {
          periodStore = tx.objectStore(PERIOD_STORE);
        }

        // entries — 스토어가 아예 없으면(신규 설치) 바로 v7 모양으로 만든다.
        // 이미 있으면(v2~v6) periodId가 없는 레거시 기록을 전부 v7 모양으로 이관한다.
        const createV7EntriesStore = () => {
          const s = _db.createObjectStore(STORE, { keyPath: 'key' });
          s.createIndex('by_time', 'time');
          s.createIndex('by_preset', 'presetId');
          s.createIndex('by_preset_period', ['presetId', 'periodId']);
          return s;
        };

        if(!_db.objectStoreNames.contains(STORE)){
          createV7EntriesStore();
          // entries가 아예 없다는 건 이관할 레거시 기록도 없다는 뜻 — periods/activePeriodId도
          // 손댈 필요 없다(사용자가 나중에 "새 회차 만들기"로 직접 만든다).
          return;
        }

        const oldStore = tx.objectStore(STORE);
        const getAllReq = oldStore.getAll();
        getAllReq.onsuccess = () => {
          const records = getAllReq.result;
          const alreadyMigrated = records.length > 0 && records[0].periodId !== undefined;
          if(oldVersion >= 7 || alreadyMigrated){
            // 이미 v7 형태 — 손대지 않는다 (안전망, v2->v3 때와 같은 패턴).
            return;
          }

          // periods 개념이 생기기 전(v2~v6) 레코드 전부 — presetId가 없는 아주 오래된
          // v2 레코드는 내장 202동 프리셋에 귀속시키고(기존 마이그레이션 원칙 그대로),
          // 전부 이번 실기기에서 실제로 확인된 회차(2026-09)에 명시적으로 배정한다.
          // "entry.time에서 월을 추론"하지 않는다 — 확정 시각과 회차는 별개 개념이다.
          const touchedPresetIds = new Set();
          const migrated = records.map(rec => {
            const presetId = rec.presetId || BUILTIN_202_PRESET_ID;
            const periodId = periodIdFor(presetId, LEGACY_V6_MIGRATION_PERIOD_LABEL);
            touchedPresetIds.add(presetId);
            return {
              key: dbKeyFor(presetId, periodId, rec.ho, rec.type),
              presetId: presetId,
              periodId: periodId,
              ho: rec.ho,
              type: rec.type,
              value: rec.value,
              time: rec.time,
              needsReview: rec.needsReview,
              reviewReasons: rec.reviewReasons,
              _legacyKey: rec.key // 아래 photos 재연결에서만 쓰고 저장 전 지운다
            };
          });

          // photos는 entries와 완전히 같은 key를 공유하므로, key가 바뀌는 이번
          // 마이그레이션에서는 반드시 같이 재연결해야 사진이 안 끊긴다.
          const photoStore = tx.objectStore(PHOTO_STORE);
          migrated.forEach(rec => {
            const oldKey = rec._legacyKey;
            const newKey = rec.key;
            delete rec._legacyKey;
            photoStore.get(oldKey).onsuccess = (pev) => {
              const photo = pev.target.result;
              if(!photo) return;
              photoStore.delete(oldKey);
              photoStore.put(Object.assign({}, photo, { key: newKey }));
            };
          });

          // entries 스토어를 v7 모양으로 재생성 — v2->v3 때 이미 검증된
          // "삭제 후 재생성 + 이관" 패턴을 그대로 재사용한다.
          _db.deleteObjectStore(STORE);
          const newStore = createV7EntriesStore();
          migrated.forEach(rec => newStore.add(rec));

          // 이 회차를 실제로 등록하고, 해당 preset의 activePeriodId로 지정한다.
          // (activePeriodId가 이미 있는 경우는 건드리지 않는다 — 안전망.)
          touchedPresetIds.forEach(presetId => {
            const periodId = periodIdFor(presetId, LEGACY_V6_MIGRATION_PERIOD_LABEL);
            periodStore.get(periodId).onsuccess = (pev) => {
              if(!pev.target.result){
                periodStore.add({
                  id: periodId,
                  presetId: presetId,
                  label: LEGACY_V6_MIGRATION_PERIOD_LABEL,
                  createdAt: new Date().toISOString()
                });
              }
            };
            presetStore.get(presetId).onsuccess = (pev) => {
              const preset = pev.target.result;
              if(preset && !preset.activePeriodId){
                preset.activePeriodId = periodId;
                presetStore.put(preset);
              }
            };
          });
        };

        // photos/outputMappings/originalFiles 스토어 — v4/v5/v6에서 이미 추가돼 있음.
        // v7에서는 손대지 않는다(그대로 존재 보장만).
        if(!_db.objectStoreNames.contains(PHOTO_STORE)){
          _db.createObjectStore(PHOTO_STORE, { keyPath: 'key' });
        }
        if(!_db.objectStoreNames.contains(OUTPUT_MAPPING_STORE)){
          const omStore = _db.createObjectStore(OUTPUT_MAPPING_STORE, { keyPath: 'id' });
          omStore.createIndex('by_preset_mapping', 'presetId');
        }
        if(!_db.objectStoreNames.contains(ORIGINAL_FILE_STORE)){
          _db.createObjectStore(ORIGINAL_FILE_STORE, { keyPath: 'key' });
        }
      };
      req.onsuccess = (e) => { db = e.target.result; resolve(db); };
      req.onerror = (e) => reject(e.target.error);
    });
  }

  // ---------------------------------------------------------------------
  // CRUD
  // ---------------------------------------------------------------------

  function dbAdd(entry){
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      // add()는 같은 key가 이미 있으면 ConstraintError로 실패한다.
      // 이게 "한 검침항목당 하나의 확정값"이라는 제약의 마지막 방어선이다.
      const req = store.add(entry);
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => { e.preventDefault(); reject(e.target.error); };
    });
  }

  function dbGetAll(){
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  // 특정 현장(presetId)의 모든 회차를 통틀은 기록. 회차 목록 화면의 완료율 계산 등
  // "회차 무관하게 전체를 봐야 하는" 드문 경우에만 쓴다 — 검침 루프는 항상
  // dbGetEntriesForPeriod를 쓴다.
  function dbGetEntriesForPreset(presetId){
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      const idx = store.index('by_preset');
      const req = idx.getAll(IDBKeyRange.only(presetId));
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  // 특정 현장의 특정 회차 기록만 가져온다. 검침 루프/현황/기록/export가 전부 이걸 쓴다.
  function dbGetEntriesForPeriod(presetId, periodId){
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      const idx = store.index('by_preset_period');
      const req = idx.getAll(IDBKeyRange.only([presetId, periodId]));
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  function dbDelete(key){
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const req = store.delete(key);
      req.onsuccess = () => resolve();
      req.onerror = (e) => reject(e.target.error);
    });
  }

  function dbGetAllPresets(){
    return new Promise((resolve, reject) => {
      const tx = db.transaction(PRESET_STORE, 'readonly');
      const store = tx.objectStore(PRESET_STORE);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  function dbSavePreset(preset){
    return new Promise((resolve, reject) => {
      const tx = db.transaction(PRESET_STORE, 'readwrite');
      const store = tx.objectStore(PRESET_STORE);
      const req = store.put(preset); // put: 같은 id면 덮어씀 (재import 허용)
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  // 회차 — presetId+label로부터 결정적 id를 쓰므로 put(=덮어쓰기)이 항상 안전하다.
  function dbSavePeriod(period){
    return new Promise((resolve, reject) => {
      const tx = db.transaction(PERIOD_STORE, 'readwrite');
      const store = tx.objectStore(PERIOD_STORE);
      const req = store.put(period);
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  function dbGetPeriodsForPreset(presetId){
    return new Promise((resolve, reject) => {
      const tx = db.transaction(PERIOD_STORE, 'readonly');
      const store = tx.objectStore(PERIOD_STORE);
      const idx = store.index('by_preset');
      const req = idx.getAll(IDBKeyRange.only(presetId));
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  function dbGetPeriod(periodId){
    return new Promise((resolve, reject) => {
      const tx = db.transaction(PERIOD_STORE, 'readonly');
      const store = tx.objectStore(PERIOD_STORE);
      const req = store.get(periodId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  // 검침 사진 저장 — entry와 동일한 key로 연결한다 (한 검침항목당 사진 최대 1장).
  function dbSavePhoto(key, presetId, dataUrl){
    return new Promise((resolve, reject) => {
      const tx = db.transaction(PHOTO_STORE, 'readwrite');
      const store = tx.objectStore(PHOTO_STORE);
      const req = store.put({ key, presetId, dataUrl, time: new Date().toISOString() });
      req.onsuccess = () => resolve();
      req.onerror = (e) => reject(e.target.error);
    });
  }

  function dbGetPhoto(key){
    return new Promise((resolve, reject) => {
      const tx = db.transaction(PHOTO_STORE, 'readonly');
      const store = tx.objectStore(PHOTO_STORE);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  // Output Mapping — "사무실에 어떤 순서/모양으로 붙여넣을지"만 담는다.
  // 절대 검침 순서(Sequence)로 쓰지 않는다. 한 현장(presetId)에 여러 개 있을 수 있다.
  function dbSaveOutputMapping(mapping){
    return new Promise((resolve, reject) => {
      const tx = db.transaction(OUTPUT_MAPPING_STORE, 'readwrite');
      const store = tx.objectStore(OUTPUT_MAPPING_STORE);
      const req = store.put(mapping); // put: 같은 id면 덮어씀 (재import 허용)
      req.onsuccess = () => resolve();
      req.onerror = (e) => reject(e.target.error);
    });
  }

  function dbGetOutputMappingsForPreset(presetId){
    return new Promise((resolve, reject) => {
      const tx = db.transaction(OUTPUT_MAPPING_STORE, 'readonly');
      const store = tx.objectStore(OUTPUT_MAPPING_STORE);
      const idx = store.index('by_preset_mapping');
      const req = idx.getAll(IDBKeyRange.only(presetId));
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  // 원본 엑셀 파일 — "원본 양식으로 결과 만들기"가 읽기 전용으로만 쓰는 Blob.
  function dbSaveOriginalFile(outputMappingId, name, type, blob){
    return new Promise((resolve, reject) => {
      const tx = db.transaction(ORIGINAL_FILE_STORE, 'readwrite');
      const store = tx.objectStore(ORIGINAL_FILE_STORE);
      const req = store.put({ key: outputMappingId, name, type, blob, time: new Date().toISOString() });
      req.onsuccess = () => resolve();
      req.onerror = (e) => reject(e.target.error);
    });
  }

  function dbGetOriginalFile(outputMappingId){
    return new Promise((resolve, reject) => {
      const tx = db.transaction(ORIGINAL_FILE_STORE, 'readonly');
      const store = tx.objectStore(ORIGINAL_FILE_STORE);
      const req = store.get(outputMappingId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  global.GumchimDb = {
    // 상수
    DB_NAME, DB_VERSION, STORE, PRESET_STORE, PHOTO_STORE,
    OUTPUT_MAPPING_STORE, ORIGINAL_FILE_STORE, PERIOD_STORE,
    BUILTIN_202_PRESET_ID, LEGACY_V6_MIGRATION_PERIOD_LABEL,
    // 순수 함수
    slugify, presetIdFromStructure, isValidPeriodLabel, periodIdFor, dbKeyFor,
    comparePeriodLabels, findPreviousPeriod, nextPeriodLabel, buildBuiltin202Preset,
    // IDB
    openDB, dbAdd, dbGetAll, dbGetEntriesForPreset, dbGetEntriesForPeriod, dbDelete,
    dbGetAllPresets, dbSavePreset, dbSavePeriod, dbGetPeriodsForPreset, dbGetPeriod,
    dbSavePhoto, dbGetPhoto, dbSaveOutputMapping, dbGetOutputMappingsForPreset,
    dbSaveOriginalFile, dbGetOriginalFile
  };

})(typeof window !== 'undefined' ? window : globalThis);
