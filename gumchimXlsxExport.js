/**
 * window.JSZip, window.GumchimXlsxPatch가 이미 로드돼 있다고 가정한다.
 * (index.html이 사용 시점에만 동적으로 두 개를 먼저 불러온 뒤 이 파일을 불러온다)
 */
(function(global){
  'use strict';

  const { patchSheetXml, TargetCellError } = global.GumchimXlsxPatch;

  // mapping.sheet(사람이 읽는 시트 이름)를 실제 zip 안의 워크시트 XML part 경로로 바꾼다.
  // 여기는 "읽기 전용" 파싱이라 DOMParser를 써도 원본 파일 보존 문제와 무관하다
  // (우리가 다시 write하는 건 오직 target 셀이 있는 sheetN.xml 문자열뿐).
  async function resolveSheetPart(zip, sheetName){
    const workbookXml = await zip.file('xl/workbook.xml').async('string');
    const relsXml = await zip.file('xl/_rels/workbook.xml.rels').async('string');

    const parser = new DOMParser();
    const workbookDoc = parser.parseFromString(workbookXml, 'text/xml');
    // 태그 이름에 네임스페이스 접두사가 붙는 경우(예: <x:sheet .../>)가 실제로 있어서,
    // 접두사 유무와 무관하게 로컬 이름만으로 찾는다 (getElementsByTagName은 접두사가
    // 다르면 못 찾는다 — 실제 사무실 파일에서 이 문제를 겪어서 고침).
    const sheets = workbookDoc.getElementsByTagNameNS('*', 'sheet');
    let rId = null;
    for(let i = 0; i < sheets.length; i++){
      if(sheets[i].getAttribute('name') === sheetName){
        rId = sheets[i].getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id')
          || sheets[i].getAttribute('r:id');
        break;
      }
    }
    if(!rId){
      throw new TargetCellError(`워크북 안에서 시트 "${sheetName}"를 찾을 수 없습니다.`);
    }

    const relsDoc = parser.parseFromString(relsXml, 'text/xml');
    const rels = relsDoc.getElementsByTagNameNS('*', 'Relationship');
    let target = null;
    for(let i = 0; i < rels.length; i++){
      if(rels[i].getAttribute('Id') === rId){
        target = rels[i].getAttribute('Target');
        break;
      }
    }
    if(!target){
      throw new TargetCellError(`시트 "${sheetName}"에 대응하는 워크시트 part를 찾을 수 없습니다.`);
    }
    // Target은 보통 "worksheets/sheet1.xml"처럼 xl/ 기준 상대경로
    return target.startsWith('/') ? target.slice(1) : 'xl/' + target;
  }

  /**
   * originalArrayBuffer: 원본 xlsx/xlsm 바이트. 이 함수는 절대 이걸 되돌려 쓰지 않는다.
   * sheetName: OutputMapping.sheet (사람이 읽는 시트 이름)
   * entries: [{ key: "2006_냉수", targetCell: "G17", value: 1238 }, ...]
   */
  async function exportPatchedWorkbook(originalArrayBuffer, sheetName, entries){
    const zip = await global.JSZip.loadAsync(originalArrayBuffer);
    const sheetPart = await resolveSheetPart(zip, sheetName);

    const sheetFile = zip.file(sheetPart);
    if(!sheetFile){
      throw new TargetCellError(`워크시트 part를 찾을 수 없습니다: ${sheetPart}`);
    }
    let sheetXml = await sheetFile.async('string');

    const applied = [];
    const failed = [];
    for(const { key, targetCell, value } of entries){
      try{
        const { xml, action } = patchSheetXml(sheetXml, targetCell, value);
        sheetXml = xml;
        applied.push({ key, targetCell, value, action });
      }catch(err){
        failed.push({ key, targetCell, value, error: err.message });
      }
    }

    if(failed.length > 0){
      // 안전조건: 하나라도 실패하면 조용히 나머지만 내보내지 않는다 — 전체를 실패로 처리한다.
      const msg = failed.map(f => `${f.key}(${f.targetCell}): ${f.error}`).join('\n');
      throw new TargetCellError(`일부 셀을 패치할 수 없어 중단합니다:\n${msg}`);
    }

    const outZip = new global.JSZip();
    const names = Object.keys(zip.files);
    for(const name of names){
      const file = zip.files[name];
      if(file.dir){ outZip.folder(name); continue; }
      if(name === sheetPart){
        outZip.file(name, sheetXml);
      } else {
        const raw = await file.async('uint8array');
        outZip.file(name, raw);
      }
    }

    const resultArrayBuffer = await outZip.generateAsync({ type: 'arraybuffer' });
    return { resultArrayBuffer, applied, sheetPart };
  }

  // 안전조건: export 후 타겟 시트 이외의 모든 part가 바이트까지 동일한지 검증 가능하게 한다.
  async function verifyUnchangedParts(originalArrayBuffer, resultArrayBuffer, sheetPart){
    const orig = await global.JSZip.loadAsync(originalArrayBuffer);
    const result = await global.JSZip.loadAsync(resultArrayBuffer);

    const origNames = Object.keys(orig.files).filter(n => !orig.files[n].dir).sort();
    const resultNames = Object.keys(result.files).filter(n => !result.files[n].dir).sort();
    const sameNameList = JSON.stringify(origNames) === JSON.stringify(resultNames);
    const report = { sameNameList, parts: [], allUnchangedPartsIdentical: true };

    for(const name of origNames){
      const ob = await orig.files[name].async('uint8array');
      const rb = result.files[name] ? await result.files[name].async('uint8array') : null;
      const identical = rb ? (ob.length === rb.length && ob.every((b,i) => b === rb[i])) : false;
      if(name !== sheetPart && !identical) report.allUnchangedPartsIdentical = false;
      report.parts.push({ name, identical, isTarget: name === sheetPart });
    }
    return report;
  }

  global.GumchimXlsxExport = { exportPatchedWorkbook, verifyUnchangedParts, resolveSheetPart };

})(typeof window !== 'undefined' ? window : globalThis);
