// 옷 사진 배경 지우기 (기기 안에서 처리, 서버 전송 없음)
// 모델: U²-Net 경량판 u2netp (Apache-2.0) / 실행: onnxruntime-web (MIT)
// 사용: await BgRemove.run(이미지 또는 캔버스) → 흰 배경 정사각 캔버스
(() => {
  'use strict';
  const BASE = new URL('./', document.currentScript?.src || location.href).href;
  const SIZE = 320; // 모델 입력 크기
  let sessionPromise = null;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (window.ort) return resolve();
      const el = document.createElement('script');
      el.src = src;
      el.onload = resolve;
      el.onerror = () => reject(new Error('배경 지우기 기능을 불러오지 못했습니다. 인터넷 연결을 확인하세요'));
      document.head.appendChild(el);
    });
  }

  function init() {
    if (!sessionPromise) {
      sessionPromise = (async () => {
        await loadScript(`${BASE}vendor/ort/ort.wasm.min.js`);
        const ort = window.ort;
        ort.env.wasm.wasmPaths = `${BASE}vendor/ort/`;
        ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
        return ort.InferenceSession.create(`${BASE}vendor/models/u2netp.onnx`, {
          executionProviders: ['wasm'],
          graphOptimizationLevel: 'all',
        });
      })().catch((e) => {
        sessionPromise = null;
        throw e;
      });
    }
    return sessionPromise;
  }

  // 원본에서 옷(가장 눈에 띄는 물체)만 남기고 흰 배경으로
  async function run(source, opts = {}) {
    const maxOut = opts.max || 1280;
    const session = await init();
    const ort = window.ort;
    const W = source.width;
    const H = source.height;

    // 1) 모델 입력 만들기 (320x320, rembg 와 같은 정규화)
    const small = document.createElement('canvas');
    small.width = SIZE;
    small.height = SIZE;
    const sctx = small.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(source, 0, 0, SIZE, SIZE);
    const px = sctx.getImageData(0, 0, SIZE, SIZE).data;
    let max = 1;
    for (let i = 0; i < px.length; i += 4) max = Math.max(max, px[i], px[i + 1], px[i + 2]);
    const mean = [0.485, 0.456, 0.406];
    const std = [0.229, 0.224, 0.225];
    const N = SIZE * SIZE;
    const input = new Float32Array(3 * N);
    for (let p = 0; p < N; p++) {
      for (let c = 0; c < 3; c++) input[c * N + p] = (px[p * 4 + c] / max - mean[c]) / std[c];
    }

    // 2) 모델 실행 → 물체일 확률 지도
    const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, SIZE, SIZE]) });
    const pred = out[session.outputNames[0]].data;
    let mn = Infinity;
    let mx = -Infinity;
    for (let i = 0; i < N; i++) {
      if (pred[i] < mn) mn = pred[i];
      if (pred[i] > mx) mx = pred[i];
    }
    const span = mx - mn || 1;

    // 3) 마스크를 원본 크기로 (부드럽게 확대)
    const mask = document.createElement('canvas');
    mask.width = SIZE;
    mask.height = SIZE;
    const mctx = mask.getContext('2d');
    const mimg = mctx.createImageData(SIZE, SIZE);
    for (let i = 0; i < N; i++) {
      const v = Math.round(((pred[i] - mn) / span) * 255);
      mimg.data[i * 4] = mimg.data[i * 4 + 1] = mimg.data[i * 4 + 2] = 255;
      mimg.data[i * 4 + 3] = v;
    }
    mctx.putImageData(mimg, 0, 0);

    const r = Math.min(1, maxOut / Math.max(W, H));
    const w = Math.round(W * r);
    const h = Math.round(H * r);
    const big = document.createElement('canvas');
    big.width = w;
    big.height = h;
    const bctx = big.getContext('2d', { willReadFrequently: true });
    bctx.drawImage(source, 0, 0, w, h);
    const img = bctx.getImageData(0, 0, w, h);
    const am = document.createElement('canvas');
    am.width = w;
    am.height = h;
    const actx = am.getContext('2d', { willReadFrequently: true });
    actx.imageSmoothingQuality = 'high';
    actx.drawImage(mask, 0, 0, w, h);
    const alpha = actx.getImageData(0, 0, w, h).data;

    // 4) 흰 배경에 합성 + 옷이 있는 영역 찾기
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;
    let solid = 0;
    const d = img.data;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        // 가장자리 정리: 약한 값은 지우고 강한 값은 꽉 채움
        let a = (alpha[i + 3] / 255 - 0.12) / 0.7;
        a = a < 0 ? 0 : a > 1 ? 1 : a;
        d[i] = d[i] * a + 255 * (1 - a);
        d[i + 1] = d[i + 1] * a + 255 * (1 - a);
        d[i + 2] = d[i + 2] * a + 255 * (1 - a);
        if (a > 0.5) {
          solid++;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (solid < w * h * 0.01 || x1 < 0) throw new Error('옷을 찾지 못했습니다. 원본 사진을 사용하세요');
    bctx.putImageData(img, 0, 0);

    // 5) 옷을 가운데 둔 정사각 흰 배경 사진으로
    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;
    const side = Math.min(maxOut, Math.round(Math.max(bw, bh) * 1.12));
    const scale = Math.min(1, (side * 0.9) / Math.max(bw, bh));
    const outC = document.createElement('canvas');
    outC.width = side;
    outC.height = side;
    const octx = outC.getContext('2d');
    octx.fillStyle = '#fff';
    octx.fillRect(0, 0, side, side);
    const dw = bw * scale;
    const dh = bh * scale;
    octx.drawImage(big, x0, y0, bw, bh, (side - dw) / 2, (side - dh) / 2, dw, dh);
    return outC;
  }

  window.BgRemove = { init, run };
})();
