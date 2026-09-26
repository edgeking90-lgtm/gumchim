'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// "현황" 세대 상세 팝업(openUnitDetail)이 검침 입력 화면(getCurrentUnitHistory)과
// 서로 다른 "이전 지침" 값을 보여주는 회귀가 실제로 있었다 — openUnitDetail이
// unit.history[type] 정적 시드값을 직접 읽고 있었기 때문이다. 이 테스트는 두 화면이
// 물리적으로 같은 getUnitHistoryFor() 하나만 거치도록 소스 레벨에서 고정해둔다.
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('getCurrentUnitHistory()는 getUnitHistoryFor()에 위임한다', () => {
  const src = html.slice(
    html.indexOf('function getCurrentUnitHistory()'),
    html.indexOf('function getCurrentUnitHistory()') + 200
  );
  assert.ok(src.includes('getUnitHistoryFor('), 'getCurrentUnitHistory()가 getUnitHistoryFor()를 호출하지 않음');
});

test('openUnitDetail()도 unit.history를 직접 읽지 않고 getUnitHistoryFor()를 호출한다', () => {
  const start = html.indexOf('function openUnitDetail(ho)');
  const end = html.indexOf('function ', start + 1);
  const src = html.slice(start, end);

  assert.ok(src.includes('getUnitHistoryFor(ho, type)'), 'openUnitDetail()이 getUnitHistoryFor()를 호출하지 않음');
  assert.ok(!/const hist = \(unit\.history/.test(src), 'openUnitDetail()이 여전히 unit.history를 직접 읽고 있음');
});
