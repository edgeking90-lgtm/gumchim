'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { GumchimDb } = require('./helpers.js');

test('slugify는 기존 index.html 구현과 byte-identical하다 (실기기 presetId 연속성)', () => {
  assert.equal(GumchimDb.slugify('202동'), '202동');
  assert.equal(GumchimDb.slugify('냉수-온수'), '냉수-온수');
  assert.equal(GumchimDb.slugify('  공백 포함  '), '공백-포함');
  assert.equal(GumchimDb.slugify(''), '');
});

test('presetIdFromStructure(엑셀/JSON로 새 현장 등록할 때)는 동+검침항목으로부터 결정적이다', () => {
  // 주의: 실기기의 202동은 이 함수가 아니라 buildBuiltin202Preset()의 내장 프리셋이라
  // id가 'builtin-202-water'로 고정돼 있다(BUILTIN_202_PRESET_ID). presetIdFromStructure는
  // 그와 별개로, 새로 Excel/JSON에서 현장을 등록할 때만 쓰인다.
  const id = GumchimDb.presetIdFromStructure({ dong: '202동', meterTypes: ['냉수', '온수'] });
  assert.equal(id, 'site-202동-냉수-온수');
  assert.equal(GumchimDb.BUILTIN_202_PRESET_ID, 'builtin-202-water');
});

test('같은 동+검침항목을 다시 구조로 넣어도 항상 같은 id (재import해도 안 늘어남)', () => {
  const a = GumchimDb.presetIdFromStructure({ dong: '101동', meterTypes: ['냉수'] });
  const b = GumchimDb.presetIdFromStructure({ dong: '101동', meterTypes: ['냉수'] });
  assert.equal(a, b);
});

test('periodIdFor는 presetId+label로 결정적이다 (같은 달 두 번 만들어도 안 늘어남)', () => {
  const a = GumchimDb.periodIdFor('site-202동-냉수-온수', '2026-10');
  const b = GumchimDb.periodIdFor('site-202동-냉수-온수', '2026-10');
  assert.equal(a, b);
  assert.notEqual(a, GumchimDb.periodIdFor('site-202동-냉수-온수', '2026-09'));
});

test('dbKeyFor는 presetId+periodId+호수+종류 네 조각으로 유일키를 만든다', () => {
  const key = GumchimDb.dbKeyFor('presetA', 'periodA', '2008', '냉수');
  assert.equal(key, 'presetA_periodA_2008_냉수');
});

test('isValidPeriodLabel — YYYY-MM만 허용, 자유 회차("10월 1차")는 거부', () => {
  assert.equal(GumchimDb.isValidPeriodLabel('2026-10'), true);
  assert.equal(GumchimDb.isValidPeriodLabel('2026-9'), false);
  assert.equal(GumchimDb.isValidPeriodLabel('10월 1차'), false);
  assert.equal(GumchimDb.isValidPeriodLabel(''), false);
});

test('comparePeriodLabels — YYYY-MM 문자열 비교만으로 시간순이 정확하다', () => {
  assert.ok(GumchimDb.comparePeriodLabels('2026-09', '2026-10') < 0);
  assert.ok(GumchimDb.comparePeriodLabels('2026-10', '2026-09') > 0);
  assert.equal(GumchimDb.comparePeriodLabels('2026-09', '2026-09'), 0);
});

test('findPreviousPeriod — 현재 회차보다 바로 이전 회차를 찾는다', () => {
  const periods = [
    { id: 'p1', label: '2026-08' },
    { id: 'p2', label: '2026-09' },
    { id: 'p3', label: '2026-10' }
  ];
  assert.equal(GumchimDb.findPreviousPeriod(periods, '2026-10').label, '2026-09');
  assert.equal(GumchimDb.findPreviousPeriod(periods, '2026-09').label, '2026-08');
  assert.equal(GumchimDb.findPreviousPeriod(periods, '2026-08'), null);
  assert.equal(GumchimDb.findPreviousPeriod([], '2026-10'), null);
});

test('nextPeriodLabel — 다음 달 제안, 연도 넘김도 정확하다', () => {
  assert.equal(GumchimDb.nextPeriodLabel('2026-09'), '2026-10');
  assert.equal(GumchimDb.nextPeriodLabel('2026-12'), '2027-01');
});
