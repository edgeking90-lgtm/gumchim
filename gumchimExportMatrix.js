/**
 * CSV/엑셀 자체 내보내기가 공유하는 표 생성 로직 — 한 세대 = 한 행,
 * 검침항목(냉수/온수 등)은 각각 별도 열. index.html의 buildWideExportRows()가
 * 이 모듈을 그대로 호출한다: CSV와 XLSX가 물리적으로 같은 함수 하나만 거치므로
 * 두 형식의 표 구조가 서로 달라질 수 없다.
 *
 * 순수 함수다 — DOM/IndexedDB/전역 상태(currentPreset, log)를 전혀 모른다.
 * 그래서 Node(tests/export-matrix.test.js)에서 그대로 가져다 테스트할 수 있다.
 *
 * 행 순서는 오직 sortedUnits(호출부가 넘겨주는, 이미 정렬된 세대 목록) 순서다 —
 * entries가 어떤 순서로 들어왔는지/lookup에 어떤 순서로 들어있는지는 절대 결과에
 * 영향을 주지 않는다. 값이 없는 항목은 그 칸만 빈 문자열이고, 행 자체가
 * 밀리거나 다른 세대 값이 섞여 들어가는 일은 없다.
 */
(function(global){
  'use strict';

  // dongLabel: 문자열. meterTypes: ['냉수','온수'] 같은 순서 있는 배열.
  // sortedUnits: [{ho:'101', ...}, ...] — 이미 원하는 순서로 정렬된 세대 목록.
  // lookup: "호수_종류" -> {value, ...} 형태의 조회용 맵(entry 자체 또는 {value}만 있어도 됨).
  function buildWideExportMatrix(dongLabel, meterTypes, sortedUnits, lookup){
    const header = ['동', '호수'].concat(meterTypes);
    const rows = (sortedUnits || []).map(u => {
      const row = [dongLabel, u.ho];
      (meterTypes || []).forEach(type => {
        const entry = lookup ? lookup[u.ho + '_' + type] : undefined;
        row.push(entry ? entry.value : '');
      });
      return row;
    });
    return { header, rows };
  }

  global.GumchimExportMatrix = { buildWideExportMatrix };

})(typeof window !== 'undefined' ? window : globalThis);
