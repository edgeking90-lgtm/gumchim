/**
 * Gumchim Excel 원본 왕복 — Open XML package 최소 패치.
 *
 * 핵심 원칙:
 * - 워크시트 XML 전체를 DOMParser/XMLSerializer로 재직렬화하지 않는다.
 *   (실증: 파싱 후 아무것도 안 바꾸고 바로 재직렬화만 해도 문자 인코딩 방식과
 *   빈 태그 표현이 바뀌어 원본과 달라짐을 확인함)
 * - <row r="N">...</row> 경계만 문자열로 찾고, 그 안의 셀 교체/삽입도
 *   문자열 스플라이싱으로만 한다.
 * - 셀 삽입 위치는 "문서에 나온 순서"가 아니라 "모든 셀의 진짜 열 번호를
 *   먼저 다 모아서 비교"해서 정한다.
 * - 타겟 셀이 이미 텍스트/수식/불리언/오류 타입이면 조용히 덮어쓰지 않고 실패한다.
 * - 실제 사무실 파일 중에는 모든 태그에 네임스페이스 접두사를 붙이는 경우가 있다
 *   (예: <x:row>, <x:c>, <x:v>, <x:f>). 접두사가 있든 없든(그리고 어떤 접두사든)
 *   똑같이 동작해야 하므로, 정규식에서 여는/닫는 태그의 접두사를 백레퍼런스(\1)로
 *   서로 맞춰 잡고, 새로 삽입하는 태그도 그 문서가 실제 쓰는 접두사를 그대로 재사용한다.
 */
(function(global){
  'use strict';

  class TargetCellError extends Error {}

  function colToNum(col){
    let n = 0;
    for(const ch of col) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n;
  }

  function splitRef(ref){
    const m = /^([A-Z]+)(\d+)$/.exec(ref);
    if(!m) throw new TargetCellError(`잘못된 셀 주소: ${ref}`);
    return { col: m[1], row: parseInt(m[2], 10) };
  }

  const CELL_RE = /<((?:[a-zA-Z0-9]+:)?)c r="([A-Z]+)(\d+)"([^>]*?)(\/>|>([\s\S]*?)<\/\1c>)/g;
  const V_TAG_RE = /<((?:[a-zA-Z0-9]+:)?)v>([\s\S]*?)<\/\1v>/;
  const F_TAG_RE = /<(?:[a-zA-Z0-9]+:)?f[ >]/;

  function findAllCellsInRow(rowXml){
    const cells = [];
    let m;
    CELL_RE.lastIndex = 0;
    while((m = CELL_RE.exec(rowXml)) !== null){
      const [full, prefix, colLetter, , attrs, tail, body] = m;
      cells.push({
        prefix,
        col: colLetter,
        colNum: colToNum(colLetter),
        start: m.index,
        end: m.index + full.length,
        attrs,
        isSelfClosing: tail === '/>',
        body: body || '',
        raw: full,
      });
    }
    return cells;
  }

  function patchCellInRowXml(rowXml, targetCol, targetRowNum, newValue, rowPrefix){
    const targetRef = `${targetCol}${targetRowNum}`;
    const targetColNum = colToNum(targetCol);
    const cells = findAllCellsInRow(rowXml);

    const existing = cells.find(c => c.col === targetCol);

    if(existing){
      const typeMatch = /t="([a-zA-Z]+)"/.exec(existing.attrs);
      const cellType = typeMatch ? typeMatch[1] : null;
      if(cellType !== null && cellType !== 'n'){
        throw new TargetCellError(
          `${targetRef}는 숫자 셀이 아닙니다(t="${cellType}"). 조용히 덮어쓰지 않고 패치를 중단합니다.`
        );
      }
      if(F_TAG_RE.test(existing.body)){
        throw new TargetCellError(
          `${targetRef}는 수식 셀입니다. 수식 셀 생성/변경은 이번 범위에 없으므로 중단합니다.`
        );
      }
      const p = existing.prefix;
      let newBody;
      if(V_TAG_RE.test(existing.body)){
        newBody = existing.body.replace(V_TAG_RE, `<${p}v>${newValue}</${p}v>`);
      } else {
        newBody = existing.body + `<${p}v>${newValue}</${p}v>`;
      }
      const newCell = `<${p}c r="${targetRef}"${existing.attrs}>${newBody}</${p}c>`;
      return {
        xml: rowXml.slice(0, existing.start) + newCell + rowXml.slice(existing.end),
        action: 'replaced',
      };
    }

    const p = cells.length > 0 ? cells[0].prefix : rowPrefix;
    const greater = cells.filter(c => c.colNum > targetColNum);
    const newCell = `<${p}c r="${targetRef}" t="n"><${p}v>${newValue}</${p}v></${p}c>`;
    if(greater.length === 0){
      const closeIdx = rowXml.lastIndexOf(`</${rowPrefix}row>`);
      if(closeIdx === -1) throw new TargetCellError(`${targetRowNum}행에서 </row> 닫는 태그를 찾을 수 없습니다.`);
      return { xml: rowXml.slice(0, closeIdx) + newCell + rowXml.slice(closeIdx), action: 'inserted' };
    }
    const insertBefore = greater.reduce((min, c) => (c.colNum < min.colNum ? c : min));
    return {
      xml: rowXml.slice(0, insertBefore.start) + newCell + rowXml.slice(insertBefore.start),
      action: 'inserted',
    };
  }

  function patchSheetXml(sheetXml, targetRef, newValue){
    const { col, row } = splitRef(targetRef);
    const rowPattern = new RegExp(`<((?:[a-zA-Z0-9]+:)?)row r="${row}"[^>]*>[\\s\\S]*?<\\/\\1row>`);
    const rm = rowPattern.exec(sheetXml);
    if(!rm){
      throw new TargetCellError(`${row}행 자체를 워크시트 XML에서 찾을 수 없습니다.`);
    }
    const rowXml = rm[0];
    const rowPrefix = rm[1];
    const { xml: patchedRow, action } = patchCellInRowXml(rowXml, col, row, newValue, rowPrefix);
    const patchedXml =
      sheetXml.slice(0, rm.index) + patchedRow + sheetXml.slice(rm.index + rowXml.length);
    return { xml: patchedXml, action };
  }

  global.GumchimXlsxPatch = { patchSheetXml, TargetCellError, colToNum, splitRef };

})(typeof window !== 'undefined' ? window : globalThis);
