'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  GumchimDb,
  resetRealDatabase,
  seedLegacyV6Database,
  buildLegacyV6Entries
} = require('./helpers.js');

// 사용자 체크리스트 1~7 (v6->v7 마이그레이션 안전성)에 정확히 대응하는 테스트 모음.
// 8번(9월 export 결과 동일성)은 export가 log(entries)를 dong/ho/type/value/time으로
// 그대로 투영만 하고 그 외 로직이 없으므로, "회차로 정확히 조회되는 entries 집합이
// 마이그레이션 전 원본 레코드 집합과 값 단위로 완전히 같다"를 확인하는 것으로 충분하다
// (아래 '9월 재-export 결과' 테스트).

test('v6 -> v7: 320건 레거시 기록이 전부 2026-09 회차로 안전하게 이관된다', async (t) => {
  await resetRealDatabase();
  const { preset, entries: legacyEntries } = buildLegacyV6Entries(GumchimDb.BUILTIN_202_PRESET_ID);
  assert.equal(legacyEntries.length, 320); // 202동 160세대 x (냉수/온수)

  const legacyPhotoKeys = [legacyEntries[0].key, legacyEntries[10].key, legacyEntries[300].key];
  const photos = legacyPhotoKeys.map(key => ({
    key, presetId: GumchimDb.BUILTIN_202_PRESET_ID, dataUrl: 'data:image/png;base64,FAKE_' + key, time: '2026-09-07T10:00:00.000Z'
  }));

  await seedLegacyV6Database({ entries: legacyEntries, photos, preset });

  const db = await GumchimDb.openDB();
  t.after(() => db.close());

  const expectedPeriodId = GumchimDb.periodIdFor(GumchimDb.BUILTIN_202_PRESET_ID, '2026-09');

  await t.test('1) 개수가 마이그레이션 전후 정확히 같다', async () => {
    const migrated = await GumchimDb.dbGetEntriesForPreset(GumchimDb.BUILTIN_202_PRESET_ID);
    assert.equal(migrated.length, 320);
  });

  await t.test('2) 각 entry의 값/호수/종류/presetId가 그대로 보존된다', async () => {
    const migrated = await GumchimDb.dbGetEntriesForPreset(GumchimDb.BUILTIN_202_PRESET_ID);
    const byOldKey = new Map(legacyEntries.map(e => [e.presetId + '_' + e.ho + '_' + e.type, e]));
    assert.equal(migrated.length, byOldKey.size);
    for(const rec of migrated){
      const oldKeyGuess = rec.presetId + '_' + rec.ho + '_' + rec.type;
      const original = byOldKey.get(oldKeyGuess);
      assert.ok(original, '원본 레코드를 못 찾음: ' + oldKeyGuess);
      assert.equal(rec.value, original.value);
      assert.equal(rec.time, original.time);
      assert.equal(rec.needsReview, original.needsReview);
      assert.deepEqual(rec.reviewReasons, original.reviewReasons);
      assert.equal(rec.presetId, GumchimDb.BUILTIN_202_PRESET_ID);
    }
  });

  await t.test('3) 320건 전부 정확히 2026-09 회차(periodId)에 귀속된다', async () => {
    const migrated = await GumchimDb.dbGetEntriesForPreset(GumchimDb.BUILTIN_202_PRESET_ID);
    assert.ok(migrated.every(e => e.periodId === expectedPeriodId));
    const viaPeriodIndex = await GumchimDb.dbGetEntriesForPeriod(GumchimDb.BUILTIN_202_PRESET_ID, expectedPeriodId);
    assert.equal(viaPeriodIndex.length, 320);
  });

  await t.test('4) periods 스토어에 2026-09 회차가 등록되고, preset.activePeriodId가 그걸 가리킨다', async () => {
    const periods = await GumchimDb.dbGetPeriodsForPreset(GumchimDb.BUILTIN_202_PRESET_ID);
    assert.equal(periods.length, 1);
    assert.equal(periods[0].id, expectedPeriodId);
    assert.equal(periods[0].label, '2026-09');

    const presets = await GumchimDb.dbGetAllPresets();
    const p = presets.find(x => x.id === GumchimDb.BUILTIN_202_PRESET_ID);
    assert.equal(p.activePeriodId, expectedPeriodId);
  });

  await t.test('5) 새 key는 presetId+periodId+호수+종류 형식이다', async () => {
    const migrated = await GumchimDb.dbGetEntriesForPreset(GumchimDb.BUILTIN_202_PRESET_ID);
    for(const rec of migrated){
      assert.equal(rec.key, GumchimDb.dbKeyFor(rec.presetId, rec.periodId, rec.ho, rec.type));
    }
  });

  await t.test('6) photos의 oldKey -> newKey 재연결이 안 끊긴다', async () => {
    for(const oldKey of legacyPhotoKeys){
      const stillUnderOldKey = await GumchimDb.dbGetPhoto(oldKey);
      assert.equal(stillUnderOldKey, null, '옛 key로는 더 이상 조회되면 안 됨: ' + oldKey);
    }
    const parts = legacyPhotoKeys[0].split('_'); // presetId_ho_type (presetId 자체엔 _ 없음: builtin-202-water)
    const ho = parts[1], type = parts[2];
    const newKey = GumchimDb.dbKeyFor(GumchimDb.BUILTIN_202_PRESET_ID, expectedPeriodId, ho, type);
    const photo = await GumchimDb.dbGetPhoto(newKey);
    assert.ok(photo, '새 key로 사진이 안 찾아짐: ' + newKey);
    assert.equal(photo.dataUrl, 'data:image/png;base64,FAKE_' + legacyPhotoKeys[0]);
  });

  await t.test('7) 9월 재-export 결과(동/호수/종류/검침값/시각 투영)가 마이그레이션 전과 완전히 같다', async () => {
    const beforeRows = new Set(legacyEntries.map(e => [preset.dong, e.ho, e.type, e.value, e.time].join('|')));
    const migrated = await GumchimDb.dbGetEntriesForPeriod(GumchimDb.BUILTIN_202_PRESET_ID, expectedPeriodId);
    const afterRows = new Set(migrated.map(e => [preset.dong, e.ho, e.type, e.value, e.time].join('|')));
    assert.equal(afterRows.size, beforeRows.size);
    for(const row of beforeRows) assert.ok(afterRows.has(row), '누락된 export row: ' + row);
  });
});

test('신규 설치(entries 자체가 없음)는 마이그레이션 없이 깨끗한 v7 스토어로 시작한다', async (t) => {
  await resetRealDatabase();
  const db = await GumchimDb.openDB(); // onupgradeneeded가 oldVersion=0으로 신규 생성
  t.after(() => db.close());

  const entries = await GumchimDb.dbGetAll();
  assert.equal(entries.length, 0);
  const periods = await GumchimDb.dbGetPeriodsForPreset(GumchimDb.BUILTIN_202_PRESET_ID);
  assert.equal(periods.length, 0); // 새 회차는 사용자가 "새 회차 만들기"로 직접 만들어야 함

  const presets = await GumchimDb.dbGetAllPresets();
  const builtin = presets.find(p => p.id === GumchimDb.BUILTIN_202_PRESET_ID);
  assert.ok(builtin, '내장 202동 프리셋은 신규 설치에도 항상 보장돼야 한다');
  assert.equal(builtin.activePeriodId, undefined);

  // 회귀 테스트: entries가 없어서 onupgradeneeded가 신규 설치 분기에서 일찍 return하더라도
  // photos/outputMappings/originalFiles 스토어는 반드시 같이 만들어져 있어야 한다.
  // (실제로 이 return 때문에 세 스토어가 전혀 안 만들어지는 버그가 있었음 — 브라우저에서
  // selectPreset() 중 dbGetOutputMappingsForPreset()가 NotFoundError로 실제로 재현됨)
  const storeNames = Array.from(db.objectStoreNames);
  assert.ok(storeNames.includes(GumchimDb.PHOTO_STORE), 'photos 스토어 누락');
  assert.ok(storeNames.includes(GumchimDb.OUTPUT_MAPPING_STORE), 'outputMappings 스토어 누락');
  assert.ok(storeNames.includes(GumchimDb.ORIGINAL_FILE_STORE), 'originalFiles 스토어 누락');
  await assert.doesNotReject(GumchimDb.dbGetOutputMappingsForPreset(GumchimDb.BUILTIN_202_PRESET_ID));
  await assert.doesNotReject(GumchimDb.dbGetPhoto('아무-key'));
});

test('presetId가 없는 아주 오래된(v2류) 레코드도 내장 202동 프리셋으로 안전하게 귀속된다', async (t) => {
  await resetRealDatabase();
  const legacyV2Style = [
    { key: '2008_냉수', ho: '2008', type: '냉수', value: '111', time: '2026-09-01T00:00:00.000Z' }
    // presetId 필드 자체가 없음 — 진짜 v2 시절 레코드처럼
  ];
  await seedLegacyV6Database({ entries: legacyV2Style });

  const db = await GumchimDb.openDB();
  t.after(() => db.close());

  const migrated = await GumchimDb.dbGetEntriesForPreset(GumchimDb.BUILTIN_202_PRESET_ID);
  assert.equal(migrated.length, 1);
  assert.equal(migrated[0].ho, '2008');
  assert.equal(migrated[0].periodId, GumchimDb.periodIdFor(GumchimDb.BUILTIN_202_PRESET_ID, '2026-09'));
});
