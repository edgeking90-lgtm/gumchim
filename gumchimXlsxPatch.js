/**
 * Gumchim Excel 원본 왕복 — Open XML package 최소 패치.
 * (내용은 검증된 gumchimXlsxPatch.js와 동일 — 번들러 없는 이 프로젝트 관례에 맞춰
 *  CommonJS 대신 전역 스코프에 window.GumchimXlsxPatch로 노출만 다르게 함)
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

  const CELL_RE = /<c r="([A-Z]+)(\d+)"([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g;

  function findAllCellsInRow(rowXml){
    const cells = [];
    let m;
    CELL_RE.lastIndex = 0;
    while((m = CELL_RE.exec(rowXml)) !== null){
      const [full, colLetter, , attrs, tail, body] = m;
      cells.push({
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

  function patchCellInRowXml(rowXml, targetCol, targetRowNum, newValue){
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
      if(existing.body.includes('<f>')){
        throw new TargetCellError(
          `${targetRef}는 수식 셀입니다. 수식 셀 생성/변경은 이번 범위에 없으므로 중단합니다.`
        );
      }
      let newBody;
      if(existing.body.includes('<v>')){
        newBody = existing.body.replace(/<v>[\s\S]*?<\/v>/, `<v>${newValue}</v>`);
      } else {
        newBody = existing.body + `<v>${newValue}</v>`;
      }
      const newCell = `<c r="${targetRef}"${existing.attrs}>${newBody}</c>`;
      return {
        xml: rowXml.slice(0, existing.start) + newCell + rowXml.slice(existing.end),
        action: 'replaced',
      };
    }

    const greater = cells.filter(c => c.colNum > targetColNum);
    const newCell = `<c r="${targetRef}" t="n"><v>${newValue}</v></c>`;
    if(greater.length === 0){
      const closeIdx = rowXml.lastIndexOf('</row>');
      if(closeIdx === -1) throw new TargetCellError(`${targetRowNum}행에서 </row>를 찾을 수 없습니다.`);
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
    const rowPattern = new RegExp(`<row r="${row}"[^>]*>[\\s\\S]*?<\\/row>`);
    const rm = rowPattern.exec(sheetXml);
    if(!rm){
      throw new TargetCellError(`${row}행 자체를 워크시트 XML에서 찾을 수 없습니다.`);
    }
    const rowXml = rm[0];
    const { xml: patchedRow, action } = patchCellInRowXml(rowXml, col, row, newValue);
    const patchedXml =
      sheetXml.slice(0, rm.index) + patchedRow + sheetXml.slice(rm.index + rowXml.length);
    return { xml: patchedXml, action };
  }

  global.GumchimXlsxPatch = { patchSheetXml, TargetCellError, colToNum, splitRef };

})(typeof window !== 'undefined' ? window : globalThis);
