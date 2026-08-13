/**
 * 엑셀로 현장 만들기 — 자동 구조 감지.
 *
 * 지금까지 실제로 확인된 두 가지 패턴을 지원한다:
 *  - WIDE: 호수 1행, 검침종류별로 컬럼이 나뉨 (예: "냉수 당월지침", "온수 당월지침")
 *  - LONG: "구분"(검침종류) 컬럼이 따로 있고, 같은 호수가 종류별로 여러 행에 나뉨,
 *          컬럼은 "N월 지침"/"N월 사용량" 반복 형태 (실제 202동 파일에서 확인된 형태)
 *
 * 원칙: 확신 없는 구조는 절대 추측해서 만들지 않는다 — { ok:false, reason } 로
 * 명확히 실패를 돌려주고, 호출 쪽(UI)이 사람에게 "이해 못 했습니다"를 보여준다.
 * 이 모듈은 "제안"만 만든다. 실제 저장은 항상 사람이 확인 화면에서 확정한 뒤에만 일어난다.
 */
(function(global){
  'use strict';

  const HO_HEADERS = ['호수', '세대', '호실'];
  const GUBUN_HEADERS = ['구분', '종류', '검침종류'];
  const TYPE_KEYWORDS = ['냉수', '온수', '전기', '가스', '수도', '온수사용량', '냉수사용량'];

  function normalizeHeader(h){
    return (h == null ? '' : String(h)).replace(/\s+/g, '').trim();
  }

  function findColIndex(headers, candidates){
    for(let i = 0; i < headers.length; i++){
      const h = normalizeHeader(headers[i]);
      if(candidates.some(c => h === c)) return i;
    }
    return -1;
  }

  function findTypeInHeader(header){
    const h = normalizeHeader(header);
    return TYPE_KEYWORDS.find(t => h.includes(t)) || null;
  }

  function colIndexToLetter(idx){
    // 0-based 인덱스를 A1 열 문자로 변환
    let n = idx + 1;
    let s = '';
    while(n > 0){
      const rem = (n - 1) % 26;
      s = String.fromCharCode(65 + rem) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  function parseFloorUnit(hoStr){
    const s = String(hoStr).trim();
    const m = /^(\d+)(\d{2})$/.exec(s);
    if(!m) return null;
    return { floor: parseInt(m[1], 10), unit: parseInt(m[2], 10) };
  }

  /**
   * LONG 포맷 감지/추출 — "구분" 컬럼이 있고, "N월 지침"/"N월 사용량" 반복 컬럼이 있는 경우.
   * 실제 202동 파일에서 검증된 방식: 요약 컬럼("최근 지침" 등)은 수식 버그 위험이 있어
   * 신뢰하지 않고, 월별 원본 데이터를 뒤에서부터 직접 스캔해서 "진짜 마지막 달"을 찾는다.
   */
  function tryDetectLong(headers, rows, sheetName){
    const hoIdx = findColIndex(headers, HO_HEADERS);
    const gubunIdx = findColIndex(headers, GUBUN_HEADERS);
    if(hoIdx === -1 || gubunIdx === -1) return null;

    // "N월 지침" / "N월 사용량" 컬럼을 순서대로 찾는다 (실제 달 순서를 보장하기 위해 월 번호로 정렬)
    const monthReadingCols = []; // [{month, colIdx}]
    for(let i = 0; i < headers.length; i++){
      const h = normalizeHeader(headers[i]);
      const m = /^(\d{1,2})월지침$/.exec(h);
      if(m) monthReadingCols.push({ month: parseInt(m[1], 10), colIdx: i });
    }
    if(monthReadingCols.length === 0) return null;
    monthReadingCols.sort((a,b) => a.month - b.month);

    const avgIdx = (() => {
      // "6개월 평균"을 우선하고, 없으면 "평균"이 들어간 아무 컬럼이나 사용
      let idx = headers.findIndex(h => normalizeHeader(h).includes('6개월') && normalizeHeader(h).includes('평균'));
      if(idx === -1) idx = headers.findIndex(h => normalizeHeader(h).includes('평균'));
      return idx;
    })();

    const unitsByHo = {};
    const cellMap = {};
    const cellMonth = {}; // 세로형(월별) 파일에서만 채워짐 — { "호수_종류": 9 } 같은 형태
    const rowOrder = [];
    const warnings = [];
    let skipped = 0;

    rows.forEach((row, rowOffset) => {
      const excelRow = rowOffset + 2; // 헤더가 1행이므로 데이터는 2행부터
      const hoRaw = row[hoIdx];
      const gubunRaw = row[gubunIdx];
      if(hoRaw == null || gubunRaw == null) return;
      const ho = String(hoRaw).trim();
      const gubun = String(gubunRaw).trim();

      let lastFilledPos = -1;
      let lastVal = null;
      for(let i = 0; i < monthReadingCols.length; i++){
        const v = row[monthReadingCols[i].colIdx];
        if(v !== null && v !== undefined && v !== ''){
          lastFilledPos = i;
          lastVal = v;
        }
      }
      if(lastVal == null){ skipped++; return; }

      const fu = parseFloorUnit(ho);
      if(!fu){ skipped++; warnings.push(`호수 "${ho}"의 층/호를 해석하지 못해 건너뜀`); return; }

      if(!unitsByHo[ho]) unitsByHo[ho] = { ho, floor: fu.floor, unit: fu.unit, history: {} };
      const histEntry = { previousReading: Math.round(Number(lastVal)) };
      if(avgIdx !== -1 && typeof row[avgIdx] === 'number'){
        histEntry.averageUsage = Math.round(row[avgIdx] * 10) / 10;
      }
      unitsByHo[ho].history[gubun] = histEntry;

      if(lastFilledPos + 1 < monthReadingCols.length){
        const nextCol = monthReadingCols[lastFilledPos + 1];
        const targetCell = colIndexToLetter(nextCol.colIdx) + excelRow;
        const key = ho + '_' + gubun;
        cellMap[key] = targetCell;
        cellMonth[key] = nextCol.month; // 세로형(월별) 파일에서만 의미 있는 "몇 월이 다음 대상인지"
        rowOrder.push(key);
      }
    });

    const units = Object.values(unitsByHo).sort((a,b) => (b.floor - a.floor) || (b.unit - a.unit));
    if(units.length === 0) return null;

    const meterTypes = Array.from(new Set(Object.values(unitsByHo).flatMap(u => Object.keys(u.history))));

    return {
      ok: true,
      format: 'long',
      preset: {
        dong: null, // 화면에서 사람이 확인/입력
        meterTypes,
        floorOrder: 'desc',
        unitOrderWithinFloor: 'desc',
        units
      },
      mapping: {
        sheet: sheetName,
        columns: meterTypes,
        rowOrder,
        cellMap,
        cellMonth
      },
      skipped,
      warnings
    };
  }

  /**
   * WIDE 포맷 감지/추출 — 호수 1행, 검침종류별로 "전월지침/당월지침" 같은 컬럼 쌍이 나뉜 경우.
   */
  function tryDetectWide(headers, rows, sheetName){
    const hoIdx = findColIndex(headers, HO_HEADERS);
    if(hoIdx === -1) return null;

    // 각 컬럼 헤더에서 검침종류를 찾고, "전월/이전" 계열과 "당월/현재" 계열, "평균" 계열을 짝짓는다.
    const typeGroups = {}; // type -> { prevIdx, curIdx, avgIdx }
    headers.forEach((h, i) => {
      const type = findTypeInHeader(h);
      if(!type) return;
      const norm = normalizeHeader(h);
      if(!typeGroups[type]) typeGroups[type] = {};
      if(/전월|이전/.test(norm) && /지침/.test(norm)) typeGroups[type].prevIdx = i;
      else if(/당월|현재|이번/.test(norm) && /지침/.test(norm)) typeGroups[type].curIdx = i;
      else if(/평균/.test(norm)) typeGroups[type].avgIdx = i;
    });

    // 검침종류 접두어가 전혀 없는 단일종류 파일도 지원 (예: 전기검침처럼 "전월지침"/"당월지침"만 있는 경우)
    if(Object.keys(typeGroups).length === 0){
      const prevIdx = headers.findIndex(h => /전월|이전/.test(normalizeHeader(h)) && /지침/.test(normalizeHeader(h)));
      const curIdx = headers.findIndex(h => (/당월|현재|이번/.test(normalizeHeader(h)) || normalizeHeader(h) === '당월지침') && /지침/.test(normalizeHeader(h)));
      if(curIdx === -1) return null;
      const avgIdx = headers.findIndex(h => /평균/.test(normalizeHeader(h)));
      typeGroups['전기'] = { prevIdx: prevIdx === -1 ? undefined : prevIdx, curIdx, avgIdx: avgIdx === -1 ? undefined : avgIdx };
    }

    const meterTypes = Object.keys(typeGroups).filter(t => typeGroups[t].curIdx !== undefined);
    if(meterTypes.length === 0) return null;

    const units = [];
    const cellMap = {};
    const rowOrder = [];
    const warnings = [];
    let skipped = 0;

    rows.forEach((row, rowOffset) => {
      const excelRow = rowOffset + 2;
      const hoRaw = row[hoIdx];
      if(hoRaw == null) return;
      const ho = String(hoRaw).trim();
      const fu = parseFloorUnit(ho);
      if(!fu){ skipped++; warnings.push(`호수 "${ho}"의 층/호를 해석하지 못해 건너뜀`); return; }

      const unit = { ho, floor: fu.floor, unit: fu.unit, history: {} };
      let any = false;
      meterTypes.forEach(type => {
        const g = typeGroups[type];
        const prev = g.prevIdx !== undefined ? row[g.prevIdx] : null;
        if(typeof prev === 'number'){
          const histEntry = { previousReading: Math.round(prev) };
          if(g.avgIdx !== undefined && typeof row[g.avgIdx] === 'number'){
            histEntry.averageUsage = Math.round(row[g.avgIdx] * 10) / 10;
          }
          unit.history[type] = histEntry;
          any = true;
        }
        const key = ho + '_' + type;
        const targetCell = colIndexToLetter(g.curIdx) + excelRow;
        cellMap[key] = targetCell;
        rowOrder.push(key);
      });
      units.push(unit);
      if(!any) { /* 이전값 없어도 세대 자체는 유효 — history 없이도 검침은 가능 */ }
    });

    if(units.length === 0) return null;

    return {
      ok: true,
      format: 'wide',
      preset: {
        dong: null,
        meterTypes,
        floorOrder: 'desc',
        unitOrderWithinFloor: 'desc',
        units
      },
      mapping: {
        sheet: sheetName,
        columns: meterTypes,
        rowOrder,
        cellMap
      },
      skipped,
      warnings
    };
  }

  /**
   * workbookSheets: [{ name, rows }] — rows[0]이 헤더, 이후가 데이터 (SheetJS sheet_to_json(ws,{header:1})의 결과 형태)
   * 여러 시트 중 감지에 성공하는 첫 시트를 쓴다. 전부 실패하면 ok:false.
   */
  function detectStructure(workbookSheets){
    const attempts = [];
    for(const sheet of workbookSheets){
      const rows = sheet.rows;
      if(!rows || rows.length < 2) continue;
      const headers = rows[0];
      const dataRows = rows.slice(1);

      const long = tryDetectLong(headers, dataRows, sheet.name);
      if(long){ return long; }
      attempts.push(sheet.name + ': long 형식 아님');

      const wide = tryDetectWide(headers, dataRows, sheet.name);
      if(wide){ return wide; }
      attempts.push(sheet.name + ': wide 형식도 아님');
    }
    return {
      ok: false,
      reason: '어떤 시트에서도 호수/검침값 구조를 알아볼 수 없습니다. 헤더에 "호수"와 검침값 컬럼(전월지침/당월지침 또는 N월 지침)이 있는지 확인해주세요.',
      attempts
    };
  }

  global.GumchimExcelAutoImport = { detectStructure, parseFloorUnit, colIndexToLetter };

})(typeof window !== 'undefined' ? window : globalThis);
