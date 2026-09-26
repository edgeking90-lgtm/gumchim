'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  GumchimDb,
  resetRealDatabase,
  seedLegacyV6Database,
  buildLegacyV6Entries
} = require('./helpers.js');

// 마이그레이션이 끝난 "이후" 정상적인 앱 사용(10월 회차 시작)을 시뮬레이션한다.
// 목표 시나리오(사용자 확인): 202동 냉수·온수 -> 새 검침 시작 -> 2026-10 ->
// 기존 320세대 구조 그대로 -> 모든 세대 미검침 -> 9월 최종값이 전월지침으로 표시.

async function migrateFromLegacyV6(){
  const { preset, entries } = buildLegacyV6Entries(GumchimDb.BUILTIN_202_PRESET_ID);
  await seedLegacyV6Database({ entries, preset });
  const db = await GumchimDb.openDB();
  return { db, preset, legacyEntries: entries };
}

test('10월 회차를 새로 만들어도 9월 320건은 절대 바뀌지 않는다', async (t) => {
  await resetRealDatabase();
  const { db, legacyEntries } = await migrateFromLegacyV6();
  t.after(() => db.close());

  const septPeriodId = GumchimDb.periodIdFor(GumchimDb.BUILTIN_202_PRESET_ID, '2026-09');
  const beforeOct = await GumchimDb.dbGetEntriesForPeriod(GumchimDb.BUILTIN_202_PRESET_ID, septPeriodId);
  assert.equal(beforeOct.length, 320);

  // "새 회차 만들기" — index.html의 btn-new-period-confirm 핸들러와 동일한 순서로 재현.
  const octPeriodId = GumchimDb.periodIdFor(GumchimDb.BUILTIN_202_PRESET_ID, '2026-10');
  await GumchimDb.dbSavePeriod({ id: octPeriodId, presetId: GumchimDb.BUILTIN_202_PRESET_ID, label: '2026-10', createdAt: new Date().toISOString() });
  const presets = await GumchimDb.dbGetAllPresets();
  const preset = presets.find(p => p.id === GumchimDb.BUILTIN_202_PRESET_ID);
  preset.activePeriodId = octPeriodId;
  await GumchimDb.dbSavePreset(preset);

  // 10월 회차는 방금 만들었으니 당연히 전부 미검침(0건)이어야 한다.
  const octEntries = await GumchimDb.dbGetEntriesForPeriod(GumchimDb.BUILTIN_202_PRESET_ID, octPeriodId);
  assert.equal(octEntries.length, 0);

  // 9월 320건은 새 회차를 만드는 동작 자체로는 단 하나도 안 바뀐다.
  const afterSept = await GumchimDb.dbGetEntriesForPeriod(GumchimDb.BUILTIN_202_PRESET_ID, septPeriodId);
  assert.equal(afterSept.length, 320);
  const sortByKey = (a, b) => a.key.localeCompare(b.key);
  assert.deepEqual(afterSept.slice().sort(sortByKey), beforeOct.slice().sort(sortByKey));

  // 10월에 한 세대만 입력해도 9월 쪽 같은 세대 값은 그대로다(유일키에 periodId가 있어 충돌하지 않음).
  const sampleHo = legacyEntries[0].ho, sampleType = legacyEntries[0].type;
  const octKey = GumchimDb.dbKeyFor(GumchimDb.BUILTIN_202_PRESET_ID, octPeriodId, sampleHo, sampleType);
  await GumchimDb.dbAdd({
    key: octKey, presetId: GumchimDb.BUILTIN_202_PRESET_ID, periodId: octPeriodId,
    ho: sampleHo, type: sampleType, value: '9999', time: new Date().toISOString(),
    needsReview: false, reviewReasons: []
  });
  const septEntryForSameUnit = (await GumchimDb.dbGetEntriesForPeriod(GumchimDb.BUILTIN_202_PRESET_ID, septPeriodId))
    .find(e => e.ho === sampleHo && e.type === sampleType);
  assert.equal(septEntryForSameUnit.value, legacyEntries[0].value); // 9월 값 그대로
});

test('전월 지침: 10월 회차의 전월값은 9월 회차의 같은 세대 확정값이다', async (t) => {
  await resetRealDatabase();
  const { db, legacyEntries } = await migrateFromLegacyV6();
  t.after(() => db.close());

  const septPeriodId = GumchimDb.periodIdFor(GumchimDb.BUILTIN_202_PRESET_ID, '2026-09');
  const octPeriodId = GumchimDb.periodIdFor(GumchimDb.BUILTIN_202_PRESET_ID, '2026-10');
  await GumchimDb.dbSavePeriod({ id: octPeriodId, presetId: GumchimDb.BUILTIN_202_PRESET_ID, label: '2026-10', createdAt: new Date().toISOString() });

  // index.html의 loadPreviousPeriodLookup()과 동일한 로직: 회차 목록에서 바로 이전 회차를
  // 찾고, 그 회차의 entries를 "호수_종류" -> value로 캐시한다.
  const periods = await GumchimDb.dbGetPeriodsForPreset(GumchimDb.BUILTIN_202_PRESET_ID);
  const currentLabel = '2026-10';
  const prev = GumchimDb.findPreviousPeriod(periods, currentLabel);
  assert.equal(prev.label, '2026-09');

  const prevEntries = await GumchimDb.dbGetEntriesForPeriod(GumchimDb.BUILTIN_202_PRESET_ID, prev.id);
  const lookup = {};
  prevEntries.forEach(e => { lookup[e.ho + '_' + e.type] = e.value; });

  const sample = legacyEntries[42];
  assert.equal(lookup[sample.ho + '_' + sample.type], sample.value);

  // 9월 데이터 자체가 수정됐는지도 다시 한번 확인 — 전월지침 조회는 읽기 전용이어야 한다.
  const septEntries = await GumchimDb.dbGetEntriesForPeriod(GumchimDb.BUILTIN_202_PRESET_ID, septPeriodId);
  assert.equal(septEntries.length, 320);
});

test('첫 회차(직전 회차 없음)는 항상 preset.units[ho].history로 폴백해야 한다(코드 계약 확인용)', async () => {
  const periods = [{ id: 'only', label: '2026-09' }];
  assert.equal(GumchimDb.findPreviousPeriod(periods, '2026-09'), null);
});
