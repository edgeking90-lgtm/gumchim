'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// 순수 함수라 fake-indexeddb/브라우저 없이 그냥 require해서 바로 쓴다.
require('../gumchimExportMatrix.js');
const { buildWideExportMatrix } = globalThis.GumchimExportMatrix;

const units = [{ ho: '101' }, { ho: '102' }, { ho: '103' }];
const meterTypes = ['냉수', '온수'];

function lookupFrom(pairs){
  // pairs: [['102_온수','202'], ...] — entries.push 순서를 일부러 뒤섞어서 넣는다.
  const lookup = {};
  pairs.forEach(([key, value]) => { lookup[key] = { value }; });
  return lookup;
}

test('entry 확정 순서가 뒤섞여 있어도, 출력 행은 항상 sortedUnits(101→102→103) 순서다', () => {
  // 사용자가 준 예시와 동일하게 저장 순서를 일부러 섞는다: 102온수, 101냉수, 103온수, 102냉수, 101온수, 103냉수
  const lookup = lookupFrom([
    ['102_온수', '202'],
    ['101_냉수', '101'],
    ['103_온수', '203'],
    ['102_냉수', '102'],
    ['101_온수', '201'],
    ['103_냉수', '103']
  ]);

  const { header, rows } = buildWideExportMatrix('202동', meterTypes, units, lookup);

  assert.deepEqual(header, ['동', '호수', '냉수', '온수']);
  assert.deepEqual(rows, [
    ['202동', '101', '101', '201'],
    ['202동', '102', '102', '202'],
    ['202동', '103', '103', '203']
  ]);
});

test('한쪽 검침값이 없으면 그 칸만 빈칸이고, 행이 밀리거나 다른 세대 값이 섞이지 않는다', () => {
  // 102호 온수만 아직 미검침 — lookup에 아예 없음.
  const lookup = lookupFrom([
    ['101_냉수', '101'],
    ['101_온수', '201'],
    ['102_냉수', '102'],
    // 102_온수 없음
    ['103_냉수', '103'],
    ['103_온수', '203']
  ]);

  const { header, rows } = buildWideExportMatrix('202동', meterTypes, units, lookup);

  assert.deepEqual(header, ['동', '호수', '냉수', '온수']);
  assert.deepEqual(rows, [
    ['202동', '101', '101', '201'],
    ['202동', '102', '102', ''],   // 온수 칸만 빈칸, 103호 값이 밀려 들어오지 않는다
    ['202동', '103', '103', '203']
  ]);
});

test('세대 자체가 아예 미검침(두 값 모두 없음)이어도 행은 만들어지고 두 칸 다 빈칸이다', () => {
  const lookup = lookupFrom([
    ['101_냉수', '101'],
    ['101_온수', '201']
    // 102, 103은 아무 기록도 없음
  ]);

  const { rows } = buildWideExportMatrix('202동', meterTypes, units, lookup);

  assert.deepEqual(rows, [
    ['202동', '101', '101', '201'],
    ['202동', '102', '', ''],
    ['202동', '103', '', '']
  ]);
});

test('lookup이 완전히 비어 있어도 세대 수만큼 빈 행을 만든다(크래시 없음)', () => {
  const { rows } = buildWideExportMatrix('202동', meterTypes, units, {});
  assert.equal(rows.length, 3);
  assert.ok(rows.every(r => r[2] === '' && r[3] === ''));
});

test('CSV/XLSX 내보내기 핸들러 둘 다 index.html에서 물리적으로 같은 buildWideExportRows() 하나만 거친다', () => {
  // 두 형식이 서로 다른 표 구조로 갈라질 수 없다는 걸 소스 레벨에서도 고정해둔다 —
  // 누군가 나중에 둘 중 한쪽에만 급하게 로직을 다시 인라인하면 이 테스트가 깨진다.
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

  const xlsxHandler = html.slice(html.indexOf("btnExportXlsx.addEventListener"), html.indexOf("btnExport.addEventListener"));
  const csvHandler = html.slice(html.indexOf("btnExport.addEventListener"), html.indexOf("// 4. 한글 숫자 파싱"));

  assert.ok(xlsxHandler.includes('buildWideExportRows()'), 'XLSX 핸들러가 buildWideExportRows()를 호출하지 않음');
  assert.ok(csvHandler.includes('buildWideExportRows()'), 'CSV 핸들러가 buildWideExportRows()를 호출하지 않음');

  // buildWideExportRows() 자신은 실제 표 생성을 GumchimExportMatrix에 위임해야 한다.
  const helperSrc = html.slice(html.indexOf('function buildWideExportRows()'), html.indexOf('const btnExportXlsx = document'));
  assert.ok(helperSrc.includes('GumchimExportMatrix.buildWideExportMatrix('), 'buildWideExportRows()가 공유 모듈을 호출하지 않음');
});
