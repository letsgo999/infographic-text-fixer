
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI } from "@google/genai";

// PDF.js CDN
const PDFJS_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const PDFJS_WORKER_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const MAX_CHAR_LIMIT = 300;
const MAX_SELECTIONS = 10; 
const STORAGE_KEY = 'ai_slide_restore_api_key';

interface SelectionArea {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface HistoryState {
  selections: SelectionArea[];
  replacements: { [key: number]: string };
}

function App() {
  const [image, setImage] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processStep, setProcessStep] = useState<string>('');
  const [selections, setSelections] = useState<SelectionArea[]>([]);
  const [replacements, setReplacements] = useState<{ [key: number]: string }>({});
  const [resultImage, setResultImage] = useState<string | null>(null);
  
  const [isKeySelected, setIsKeySelected] = useState<boolean | null>(null);
  const [manualKey, setManualKey] = useState<string>('');
  const [showManualInput, setShowManualInput] = useState(false);

  const [history, setHistory] = useState<HistoryState[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  const [pdfDoc, setPdfDoc] = useState<any>(null);
  const [currentPageNum, setCurrentPageNum] = useState(1);
  const [numPages, setNumPages] = useState(0);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const isDrawing = useRef(false);
  const startPos = useRef({ x: 0, y: 0 });

  useEffect(() => {
    checkInitialKeyStatus();
    loadPdfLibrary();
    const savedKey = localStorage.getItem(STORAGE_KEY);
    if (savedKey) setManualKey(savedKey);
  }, []);

  const checkInitialKeyStatus = async () => {
    try {
      if (window.aistudio?.hasSelectedApiKey) {
        const selected = await window.aistudio.hasSelectedApiKey();
        if (selected) {
          setIsKeySelected(true);
          return;
        }
      }
      const savedKey = localStorage.getItem(STORAGE_KEY);
      if (savedKey && savedKey.length > 10) setIsKeySelected(true);
      else setIsKeySelected(false);
    } catch (e) {
      setIsKeySelected(false);
    }
  };

  const loadPdfLibrary = () => {
    const script = document.createElement('script');
    script.src = PDFJS_SRC;
    script.onload = () => {
      (window as any).pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_SRC;
    };
    document.head.appendChild(script);
  };

  const handleOpenKeySelector = async () => {
    if (window.aistudio?.openSelectKey) {
      try { await window.aistudio.openSelectKey(); setIsKeySelected(true); } 
      catch (e) { setShowManualInput(true); }
    } else { setShowManualInput(true); }
  };

  const handleSaveManualKey = () => {
    if (manualKey.trim().length < 10) { alert("올바른 API 키를 입력해주세요."); return; }
    localStorage.setItem(STORAGE_KEY, manualKey.trim());
    setIsKeySelected(true);
  };

  const pushToHistory = useCallback((newSelections: SelectionArea[], newReplacements: { [key: number]: string }) => {
    const newState: HistoryState = {
      selections: JSON.parse(JSON.stringify(newSelections)),
      replacements: { ...newReplacements },
    };
    setHistory((prev) => {
      const truncated = prev.slice(0, historyIndex + 1);
      const updated = [...truncated, newState];
      return updated.length > 50 ? updated.slice(1) : updated;
    });
    setHistoryIndex((prev) => Math.min(prev + 1, 49));
  }, [historyIndex]);

  const undo = () => {
    if (historyIndex > 0) {
      const prevState = history[historyIndex - 1];
      setSelections(prevState.selections);
      setReplacements(prevState.replacements);
      setHistoryIndex(historyIndex - 1);
    } else if (historyIndex === 0) {
      setSelections([]); setReplacements({}); setHistoryIndex(-1);
    }
  };

  const redo = () => {
    if (historyIndex < history.length - 1) {
      const nextState = history[historyIndex + 1];
      setSelections(nextState.selections);
      setReplacements(nextState.replacements);
      setHistoryIndex(historyIndex + 1);
    }
  };

  const renderPdfPage = async (pdf: any, pageNum: number) => {
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: 4 });
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    canvas.height = viewport.height;
    canvas.width = viewport.width;
    await page.render({ canvasContext: context, viewport: viewport }).promise;
    setImage(canvas.toDataURL('image/png'));
    setResultImage(null); setSelections([]); setReplacements({}); setHistory([]); setHistoryIndex(-1);
  };

  const handlePdfUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || file.type !== 'application/pdf') return;
    const reader = new FileReader();
    reader.onload = async (event) => {
      const typedArray = new Uint8Array(event.target?.result as ArrayBuffer);
      const pdf = await (window as any).pdfjsLib.getDocument(typedArray).promise;
      setPdfDoc(pdf); setNumPages(pdf.numPages); setCurrentPageNum(1);
      await renderPdfPage(pdf, 1);
    };
    reader.readAsArrayBuffer(file);
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPdfDoc(null);
    const reader = new FileReader();
    reader.onload = (event) => {
      setImage(event.target?.result as string);
      setResultImage(null); setSelections([]); setReplacements({}); setHistory([]); setHistoryIndex(-1);
    };
    reader.readAsDataURL(file);
  };

  const handlePageChange = async (newPageNum: number) => {
    if (newPageNum < 1 || newPageNum > numPages || !pdfDoc) return;
    setCurrentPageNum(newPageNum);
    await renderPdfPage(pdfDoc, newPageNum);
  };

  const drawImageAndSelection = () => {
    const canvas = canvasRef.current;
    if (!canvas || !image) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = new Image();
    img.onload = () => {
      canvas.width = img.width; canvas.height = img.height;
      ctx.drawImage(img, 0, 0);
      selections.forEach((sel, index) => {
        const num = index + 1;
        ctx.strokeStyle = '#ef4444'; ctx.lineWidth = 4;
        ctx.strokeRect(sel.x, sel.y, sel.w, sel.h);
        ctx.fillStyle = 'rgba(239, 68, 68, 0.1)'; ctx.fillRect(sel.x, sel.y, sel.w, sel.h);
        const tagSize = 30;
        ctx.fillStyle = '#ef4444'; ctx.fillRect(sel.x + sel.w - tagSize, sel.y, tagSize, tagSize);
        ctx.fillStyle = 'white'; ctx.font = 'bold 20px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(num.toString(), sel.x + sel.w - tagSize / 2, sel.y + tagSize / 2);
      });
    };
    img.src = image;
  };

  useEffect(() => { if (isKeySelected) drawImageAndSelection(); }, [image, selections, isKeySelected]);

  const getCanvasCoords = (e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (isProcessing) return;
    if (selections.length >= MAX_SELECTIONS) {
      alert(`최적의 품질을 위해 한 번에 최대 ${MAX_SELECTIONS}개 구역까지만 권장합니다.`);
      return;
    }
    isDrawing.current = true;
    const pos = getCanvasCoords(e);
    startPos.current = pos;
    const newId = Date.now();
    setSelections(prev => [...prev, { id: newId, x: pos.x, y: pos.y, w: 0, h: 0 }]);
  };

  const onMouseMove = (e: React.MouseEvent) => {
    if (!isDrawing.current) return;
    const currentPos = getCanvasCoords(e);
    setSelections(prev => {
      const updated = [...prev];
      const last = updated[updated.length - 1];
      if (last) {
        last.x = Math.min(startPos.current.x, currentPos.x); last.y = Math.min(startPos.current.y, currentPos.y);
        last.w = Math.abs(currentPos.x - startPos.current.x); last.h = Math.abs(currentPos.y - startPos.current.y);
      }
      return updated;
    });
  };

  const onMouseUp = () => { if (isDrawing.current) { isDrawing.current = false; pushToHistory(selections, replacements); } };

  const updateReplacement = (id: number, text: string) => {
    if (text.length > MAX_CHAR_LIMIT) return;
    setReplacements(prev => ({ ...prev, [id]: text }));
  };

  const handleReplacementBlur = (id: number) => {
    const lastHistoryState = history[historyIndex];
    if (!lastHistoryState || lastHistoryState.replacements[id] !== replacements[id]) {
      pushToHistory(selections, replacements);
    }
  };

  const removeSelection = (id: number) => {
    const newSelections = selections.filter(s => s.id !== id);
    const newReplacements = { ...replacements }; delete newReplacements[id];
    setSelections(newSelections); setReplacements(newReplacements);
    pushToHistory(newSelections, newReplacements);
  };

  /**
   * 픽셀 컴포지팅 기반 정밀 복원 함수
   */
  const handleRestore = async (targetSize: "1K" | "2K" | "4K") => {
    if (!image || selections.length === 0) return;
    
    const filteredSelections = selections.filter(s => (replacements[s.id] || "").trim() !== "");
    if (filteredSelections.length === 0) { alert("교정할 내용을 입력해주세요."); return; }

    setIsProcessing(true);
    setProcessStep('AI 분석 및 텍스트 렌더링 중...');
    
    try {
      const activeKey = localStorage.getItem(STORAGE_KEY) || process.env.API_KEY;
      const ai = new GoogleGenAI({ apiKey: activeKey });
      const base64Data = image.split(',')[1];
      const originalCanvas = canvasRef.current!;

      const areasInstructions = filteredSelections.map((sel, idx) => {
        const text = replacements[sel.id] || "";
        const normX = Math.round((sel.x / originalCanvas.width) * 1000);
        const normY = Math.round((sel.y / originalCanvas.height) * 1000);
        const normW = Math.round((sel.w / originalCanvas.width) * 1000);
        const normH = Math.round((sel.h / originalCanvas.height) * 1000);
        return `[AREA ${idx + 1}]: X=${normX}, Y=${normY}, W=${normW}, H=${normH}, TEXT="${text}"`;
      }).join('\n');

      const prompt = `TASK: ULTRA-HD KOREAN TYPOGRAPHY RESTORATION & SELF-CHECK
You are a top-tier vector font artist. Restore Korean text perfectly. Maintain original layout and font weight.

CRITICAL INSTRUCTIONS:
1. ONLY modify pixels within the boxes. 
2. [SELF-CHECK]: Before final output, ensure all Korean characters are sharp, correctly spelled, and legible.
3. DO NOT smooth or change any pixels outside the specified boxes.
4. If a box contains a speech bubble or specific colored background, match the original style exactly.

TARGET AREAS:
${areasInstructions}`;

      const response = await ai.models.generateContent({
        model: 'gemini-3-pro-image-preview',
        contents: { parts: [{ inlineData: { data: base64Data, mimeType: 'image/png' } }, { text: prompt }] },
        config: { 
          thinkingConfig: { thinkingBudget: 32768 },
          imageConfig: { imageSize: targetSize, aspectRatio: originalCanvas.width / originalCanvas.height > 1.2 ? "16:9" : "4:3" }
        }
      });

      setProcessStep('품질 자가 검수 및 픽셀 합성 중...');

      let aiResultBase64 = null;
      for (const part of response.candidates?.[0]?.content?.parts || []) {
        if (part.inlineData) { aiResultBase64 = part.inlineData.data; break; }
      }

      if (!aiResultBase64) throw new Error("이미지 생성 실패");

      // 합성 로직 (Compositing)
      const originalImg = new Image();
      originalImg.src = image;
      await new Promise(r => originalImg.onload = r);

      const aiImg = new Image();
      aiImg.src = `data:image/png;base64,${aiResultBase64}`;
      await new Promise(r => aiImg.onload = r);

      // 캔버스 생성 및 합성 시작
      const compositeCanvas = document.createElement('canvas');
      compositeCanvas.width = originalImg.width;
      compositeCanvas.height = originalImg.height;
      const ctx = compositeCanvas.getContext('2d')!;

      // 1. 원본을 먼저 그린다 (무손실 배경 유지)
      ctx.drawImage(originalImg, 0, 0);

      // 2. AI가 생성한 이미지에서 선택 구역만 잘라내어 덮어씌운다
      filteredSelections.forEach(sel => {
        // AI 이미지에서 해당 박스 좌표 계산
        const scaleX = aiImg.width / originalImg.width;
        const scaleY = aiImg.height / originalImg.height;

        ctx.drawImage(
          aiImg, 
          sel.x * scaleX, sel.y * scaleY, sel.w * scaleX, sel.h * scaleY, // 소스(AI)
          sel.x, sel.y, sel.w, sel.h // 대상(원본 위)
        );
      });

      setResultImage(compositeCanvas.toDataURL('image/png'));
      setProcessStep('복원 완료!');
      setTimeout(() => resultRef.current?.scrollIntoView({ behavior: 'smooth' }), 300);

    } catch (error: any) {
      alert("처리에 오류가 발생했습니다. 구역을 더 좁게 지정하거나 API 키를 확인해주세요.");
    } finally {
      setIsProcessing(false);
    }
  };

  const downloadResult = () => {
    if (!resultImage) return;
    const link = document.createElement('a');
    link.href = resultImage;
    link.download = `Precision_Restored_${Date.now()}.png`;
    link.click();
  };

  if (isKeySelected === false) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6" style={{ fontFamily: "'Noto Sans KR', sans-serif" }}>
        <div className="max-w-md w-full bg-white rounded-[40px] shadow-2xl p-10 text-center border border-gray-100 animate-in zoom-in duration-500">
          <div className="w-24 h-24 bg-indigo-50 rounded-full flex items-center justify-center mx-auto mb-8">
            <svg className="w-12 h-12 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" /></svg>
          </div>
          <h1 className="text-3xl font-bold text-gray-900 mb-4 tracking-tight">AI 인포그래픽 이미지 한글 텍스트 정밀 교정기 v1.1</h1>
          <p className="text-gray-500 font-bold mb-8 leading-relaxed">
            고품질 합성 처리를 위해 본인의 API 키를 입력하세요.
            <br />
            <a href="https://aistudio.google.com/api-keys" target="_blank" rel="noopener noreferrer" className="text-indigo-600 underline">여기</a>를 클릭하여 새 키를 발급받으세요.
          </p>
          {showManualInput ? (
            <div className="space-y-4">
              <input type="password" placeholder="Gemini API 키 입력" value={manualKey} onChange={(e) => setManualKey(e.target.value)} className="w-full px-5 py-4 border-2 border-indigo-100 rounded-2xl focus:border-indigo-500 outline-none font-bold text-center" />
              <button onClick={handleSaveManualKey} className="w-full bg-indigo-600 text-white py-4 rounded-2xl font-bold text-lg shadow-xl shadow-indigo-100 active:scale-95 transition-all">키 저장 후 시작</button>
            </div>
          ) : (
            <button onClick={handleOpenKeySelector} className="w-full bg-indigo-600 text-white py-4 rounded-2xl font-bold text-lg shadow-xl active:scale-95 transition-all">API 키 설정하기</button>
          )}
        </div>
      </div>
    );
  }

  if (isKeySelected === null) return <div className="min-h-screen bg-gray-50 flex items-center justify-center"><div className="w-12 h-12 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin"></div></div>;

  return (
    <div className="min-h-screen bg-gray-50 p-6 font-sans text-gray-900" style={{ fontFamily: "'Noto Sans KR', sans-serif" }}>
      <header className="max-w-7xl mx-auto mb-6 flex flex-col md:flex-row justify-between items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold text-indigo-700 tracking-tight">AI 인포그래픽 이미지 한글 텍스트 정밀 교정기 v1.1</h1>
          <p className="text-gray-500 font-bold">원본 화질은 유지하고, 지정 영역만 정밀하게 합성합니다.</p>
        </div>
        <button onClick={() => { localStorage.removeItem(STORAGE_KEY); setIsKeySelected(false); setShowManualInput(true); }} className="bg-white border border-gray-200 text-gray-600 px-5 py-2 rounded-full font-bold text-sm shadow-sm active:scale-95 transition-all flex items-center gap-2">
          키 변경하기
        </button>
      </header>

      <main className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-4 gap-6 h-[85vh]">
        <aside className="lg:col-span-1 overflow-y-auto pr-2 custom-scrollbar bg-white rounded-3xl p-5 border border-gray-100 shadow-sm space-y-5">
          <div className="space-y-5">
            <section>
              <h2 className="text-sm font-bold uppercase tracking-wider text-gray-400 mb-3 font-bold">파일 업로드</h2>
              <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col items-center justify-center border-2 border-dashed border-indigo-100 rounded-xl p-3 cursor-pointer hover:bg-indigo-50 transition-colors">
                  <span className="text-indigo-600 font-bold text-xs">📄 PDF</span>
                  <input type="file" accept="application/pdf" onChange={handlePdfUpload} className="hidden" />
                </label>
                <label className="flex flex-col items-center justify-center border-2 border-dashed border-purple-100 rounded-xl p-3 cursor-pointer hover:bg-purple-50 transition-colors">
                  <span className="text-purple-600 font-bold text-xs">🖼️ 이미지</span>
                  <input type="file" accept="image/*" onChange={handleImageUpload} className="hidden" />
                </label>
              </div>
            </section>

            <section>
              <h2 className="text-sm font-bold uppercase tracking-wider text-gray-400 mb-2 font-bold">편집 도구</h2>
              <div className="flex gap-2">
                <button onClick={undo} disabled={historyIndex < 0} className="flex-1 flex items-center justify-center gap-1 py-2 bg-white border border-gray-200 rounded-xl text-xs font-bold text-gray-600 disabled:opacity-30">Undo</button>
                <button onClick={redo} disabled={historyIndex >= history.length - 1} className="flex-1 flex items-center justify-center gap-1 py-2 bg-white border border-gray-200 rounded-xl text-xs font-bold text-gray-600 disabled:opacity-30">Redo</button>
              </div>
            </section>

            {pdfDoc && (
              <section>
                <h2 className="text-sm font-bold uppercase tracking-wider text-gray-400 mb-2 font-bold">페이지 탐색</h2>
                <div className="flex items-center justify-between gap-4 bg-gray-50 p-2 rounded-2xl border border-gray-100 shadow-inner">
                  <button onClick={() => handlePageChange(currentPageNum - 1)} disabled={currentPageNum <= 1} className="p-1 disabled:opacity-10"><svg className="w-8 h-8 text-gray-800" fill="currentColor" viewBox="0 0 24 24"><path d="M14 7l-5 5 5 5V7z" /></svg></button>
                  <span className="font-bold text-indigo-700">{currentPageNum} / {numPages}</span>
                  <button onClick={() => handlePageChange(currentPageNum + 1)} disabled={currentPageNum >= numPages} className="p-1 disabled:opacity-10"><svg className="w-8 h-8 text-gray-800" fill="currentColor" viewBox="0 0 24 24"><path d="M10 7l5 5-5 5V7z" /></svg></button>
                </div>
              </section>
            )}

            <section className="space-y-4">
              <h2 className="text-sm font-bold uppercase tracking-wider text-gray-400 font-bold">교정 설정 ({selections.length}/{MAX_SELECTIONS})</h2>
              {selections.map((sel, index) => (
                <div key={sel.id} className="p-3 bg-gray-50 rounded-2xl border border-gray-200 animate-in slide-in-from-left-2 duration-300">
                  <div className="flex justify-between items-center mb-1">
                    <span className="bg-indigo-600 text-white w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold">{index + 1}</span>
                    <button onClick={() => removeSelection(sel.id)} className="text-gray-400 hover:text-red-500 transition-colors"><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M6 18L18 6M6 6l12 12" /></svg></button>
                  </div>
                  <textarea placeholder="교정할 텍스트" value={replacements[sel.id] || ""} onChange={(e) => updateReplacement(sel.id, e.target.value)} onBlur={() => handleReplacementBlur(sel.id)} className="w-full p-2 text-xs border border-gray-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none h-16 resize-none bg-white font-bold" />
                </div>
              ))}
            </section>
            
            <div className="space-y-3 pt-2">
              <button onClick={() => handleRestore("1K")} disabled={isProcessing || !image || selections.length === 0} className={`w-full py-4 rounded-2xl font-bold text-white shadow-lg active:scale-95 transition-all ${isProcessing || !image || selections.length === 0 ? 'bg-gray-300' : 'bg-blue-600 hover:bg-blue-700'}`}>원본 복원 (1K)</button>
              <button onClick={() => handleRestore("2K")} disabled={isProcessing || !image || selections.length === 0} className={`w-full py-4 rounded-2xl font-bold text-white shadow-lg active:scale-95 transition-all ${isProcessing || !image || selections.length === 0 ? 'bg-gray-300' : 'bg-indigo-600 hover:bg-indigo-700'}`}>정밀 복원 (2K)</button>
              <button onClick={() => handleRestore("4K")} disabled={isProcessing || !image || selections.length === 0} className={`w-full py-4 rounded-2xl font-bold text-white shadow-lg active:scale-95 transition-all ${isProcessing || !image || selections.length === 0 ? 'bg-gray-300' : 'bg-purple-600 hover:bg-purple-700'}`}>정밀 복원 (4K)</button>
              <button onClick={downloadResult} disabled={!resultImage || isProcessing} className={`w-full py-4 rounded-2xl font-bold text-white shadow-lg active:scale-95 transition-all ${!resultImage || isProcessing ? 'bg-gray-200 text-gray-400' : 'bg-green-600 hover:bg-green-700'}`}>[복원 파일 다운로드]</button>
            </div>
          </div>
        </aside>

        <section className="lg:col-span-3 h-full overflow-y-auto custom-scrollbar flex flex-col gap-10">
          <div className="bg-white p-3 rounded-3xl shadow-inner border border-gray-200 flex justify-center items-start bg-grid min-h-[400px]">
            {!image ? (
              <div className="py-20 text-gray-400 flex flex-col items-center"><p className="text-sm font-bold">파일을 업로드하세요.</p></div>
            ) : (
              <div className="relative inline-block">
                <canvas ref={canvasRef} onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp} className="cursor-crosshair shadow-lg rounded-sm" style={{ maxWidth: '100%', height: 'auto' }} />
                {isProcessing && (
                  <div className="absolute inset-0 bg-white/60 backdrop-blur-md flex items-center justify-center z-50">
                    <div className="bg-white p-8 rounded-[40px] shadow-2xl flex flex-col items-center border-4 border-indigo-100">
                      <div className="w-16 h-16 border-8 border-indigo-600 border-t-transparent rounded-full animate-spin mb-6"></div>
                      <p className="font-bold text-indigo-700 text-xl mb-2">{processStep}</p>
                      <p className="text-gray-500 font-bold text-sm">원본 배경을 보존하며 영역만 정밀하게 합성 중입니다...</p>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {resultImage && (
            <div ref={resultRef} className="bg-white p-10 rounded-[40px] shadow-2xl border-4 border-green-500 mt-32 mb-32 mx-4">
              <div className="flex justify-between items-center mb-8 pb-4 border-b-2 border-green-100">
                <h3 className="text-2xl font-bold text-green-800">✨ 무손실 배경 합성 결과물</h3>
                <button onClick={downloadResult} className="px-8 py-3 bg-green-600 text-white font-bold rounded-2xl">다운로드</button>
              </div>
              <div className="flex justify-center bg-gray-50 p-6 rounded-3xl border-2 border-dashed border-gray-200 overflow-hidden">
                <img src={resultImage} alt="Restored" className="max-w-full rounded-2xl shadow-2xl" />
              </div>
              <p className="mt-6 text-center text-gray-400 font-bold italic">※ 배경 열화 없이 지정된 {selections.length}개 구역만 교정되었습니다.</p>
            </div>
          )}
        </section>
      </main>

      <style>{`
        .bg-grid { background-color: #f8fafc; background-image: radial-gradient(#e2e8f0 1.2px, transparent 1.2px); background-size: 32px 32px; }
        .custom-scrollbar::-webkit-scrollbar { width: 6px; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 10px; }
        @keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
      `}</style>
    </div>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
