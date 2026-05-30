const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== CONFIG ====================
const API_URL_HU = 'https://wtx.tele68.com/v1/tx/sessions';
const API_URL_MD5 = 'https://wtxmd52.tele68.com/v1/txmd5/sessions';
const ADMIN_NAME = 'HuyDaiXuVN';

// ==================== IN-MEMORY STORES ====================
const predictions = [];
let predictionIdCounter = 0;
const MAX_PREDICTIONS = 500;
let pingCount = 0;
const startTime = Date.now();

// ==================== UTILS ====================
function formatTime(date) {
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function transformData(list) {
  if (!list || !Array.isArray(list)) return [];
  const sorted = [...list].sort((a, b) => b.id - a.id);
  return sorted.map(item => ({
    phien: item.id,
    xuc_xac_1: item.dices[0],
    xuc_xac_2: item.dices[1],
    xuc_xac_3: item.dices[2],
    tong: item.point,
    ket_qua: (item.resultTruyenThong || '').toLowerCase(), // luôn chữ thường
    admin: ADMIN_NAME,
    update: formatTime(new Date())
  }));
}

async function fetchWithRetry(apiUrl, retries = 2, delay = 1000) {
  for (let i = 0; i <= retries; i++) {
    try {
      const response = await axios.get(apiUrl, { timeout: 10000 });
      if (response.data && Array.isArray(response.data.list)) return response.data.list;
      throw new Error('Invalid structure');
    } catch (err) {
      console.error(`Attempt ${i + 1} failed for ${apiUrl}: ${err.message}`);
      if (i < retries) await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error(`Failed after ${retries + 1} attempts`);
}

async function fetchHistory(apiUrl) {
  const raw = await fetchWithRetry(apiUrl);
  return transformData(raw);
}

// ==================== CHECK REAL-TIME CORRECTNESS ====================
async function checkPendingPredictions() {
  const pending = predictions.filter(p => p.status === 'pending');
  if (pending.length === 0) return;
  const byGame = { lc79: [], md5: [] };
  pending.forEach(p => byGame[p.game]?.push(p));
  for (const [game, preds] of Object.entries(byGame)) {
    if (preds.length === 0) continue;
    try {
      const apiUrl = game === 'lc79' ? API_URL_HU : API_URL_MD5;
      const history = await fetchHistory(apiUrl);
      const mapKetQua = {};
      history.forEach(item => { mapKetQua[item.phien] = item.ket_qua; });
      for (const pred of preds) {
        if (mapKetQua[pred.predictedPhien] !== undefined) {
          pred.actualKetQua = mapKetQua[pred.predictedPhien];
          pred.status = (pred.prediction === pred.actualKetQua) ? 'correct' : 'incorrect';
          pred.checkedAt = new Date().toISOString();
        }
      }
    } catch (err) {
      console.error(`Check failed for ${game}:`, err.message);
    }
  }
  if (predictions.length > MAX_PREDICTIONS) {
    const sorted = [...predictions].sort((a, b) => b.timestamp - a.timestamp);
    predictions.length = 0;
    predictions.push(...sorted.slice(0, MAX_PREDICTIONS));
  }
}
setInterval(checkPendingPredictions, 15000);

// ==================== 25 THUẬT TOÁN SIÊU VIP (KHÔNG RANDOM) ====================

// Helper kiểm tra đầu vào cho mọi thuật toán
function safeAlgo(historyAsc, minLen, cb) {
  if (!historyAsc || historyAsc.length < minLen) {
    const last = historyAsc && historyAsc.length > 0 ? historyAsc[historyAsc.length-1].ket_qua : 'tai';
    return { prediction: last, confidence: 40, algorithm: 'Fallback (thiếu dữ liệu)' };
  }
  return cb();
}

// 1. EMA Cross (3 phiên nhanh, 7 phiên chậm)
function algoEMACross(historyAsc) {
  return safeAlgo(historyAsc, 8, () => {
    const prices = historyAsc.map(i => i.tong);
    const ema = (data, p) => { const k=2/(p+1); let e=data[0]; for (let i=1;i<data.length;i++) e=data[i]*k+e*(1-k); return e; };
    const fast = ema(prices.slice(-3), 3);
    const slow = ema(prices.slice(-7), 7);
    const prediction = fast > slow ? 'tai' : 'xiu';
    return { prediction, confidence: Math.min(75, Math.abs(fast-slow)*10), algorithm: 'EMA Cross (3/7)' };
  });
}

// 2. MACD (6,13,5)
function algoMACD(historyAsc) {
  return safeAlgo(historyAsc, 18, () => {
    const prices = historyAsc.map(i => i.tong);
    const ema = (data, p) => { const k=2/(p+1); let arr=[data[0]]; for (let i=1;i<data.length;i++) arr.push(data[i]*k+arr[i-1]*(1-k)); return arr; };
    const emaFast = ema(prices, 6);
    const emaSlow = ema(prices, 13);
    const macd = emaFast.map((v,i) => v - emaSlow[i]);
    const signal = ema(macd.slice(-5*2), 5);
    const lastMACD = macd[macd.length-1], lastSignal = signal[signal.length-1];
    const prediction = lastMACD > lastSignal ? 'tai' : 'xiu';
    return { prediction, confidence: 55 + Math.min(20, Math.abs(lastMACD-lastSignal)*5), algorithm: 'MACD (6,13,5)' };
  });
}

// 3. RSI tổng điểm (14 phiên)
function algoRSI(historyAsc) {
  return safeAlgo(historyAsc, 15, () => {
    const period = 14;
    const changes = [];
    for (let i=historyAsc.length-period; i<historyAsc.length; i++) changes.push(historyAsc[i].tong - historyAsc[i-1].tong);
    let avgGain=0, avgLoss=0;
    changes.forEach(c => { if(c>0) avgGain+=c; else avgLoss+=Math.abs(c); });
    avgGain/=period; avgLoss/=period;
    if (avgLoss===0) return { prediction:'tai', confidence:80, algorithm:'RSI (14)' };
    const rs=avgGain/avgLoss, rsi=100-(100/(1+rs));
    return { prediction: rsi>50?'tai':'xiu', confidence: Math.min(80, Math.abs(rsi-50)+40), algorithm:'RSI (14)' };
  });
}

// 4. Bollinger Bands (20,2)
function algoBollinger(historyAsc) {
  return safeAlgo(historyAsc, 20, () => {
    const period=20, mult=2;
    const prices = historyAsc.slice(-period).map(i => i.tong);
    const ma = prices.reduce((a,b)=>a+b,0)/period;
    const variance = prices.reduce((s,x)=>s+Math.pow(x-ma,2),0)/period;
    const std = Math.sqrt(variance);
    const upper = ma+mult*std, lower = ma-mult*std;
    const last = prices[prices.length-1];
    let prediction;
    if (last >= upper) prediction = 'xiu';
    else if (last <= lower) prediction = 'tai';
    else prediction = last > ma ? 'tai' : 'xiu';
    return { prediction, confidence: 55, algorithm: 'Bollinger (20,2)' };
  });
}

// 5. Ichimoku (9,26)
function algoIchimoku(historyAsc) {
  return safeAlgo(historyAsc, 26, () => {
    const tenkan=9, kijun=26;
    const recent = historyAsc.slice(-kijun);
    const highT = Math.max(...recent.slice(-tenkan).map(i=>i.tong));
    const lowT = Math.min(...recent.slice(-tenkan).map(i=>i.tong));
    const tenkanSen = (highT+lowT)/2;
    const highK = Math.max(...recent.map(i=>i.tong));
    const lowK = Math.min(...recent.map(i=>i.tong));
    const kijunSen = (highK+lowK)/2;
    const last = recent[recent.length-1].tong;
    let prediction;
    if (last > Math.max(tenkanSen, kijunSen)) prediction = 'tai';
    else if (last < Math.min(tenkanSen, kijunSen)) prediction = 'xiu';
    else prediction = last > (tenkanSen+kijunSen)/2 ? 'tai' : 'xiu';
    return { prediction, confidence: 55, algorithm: 'Ichimoku (9,26)' };
  });
}

// 6. ATR biến động (7 phiên)
function algoATR(historyAsc) {
  return safeAlgo(historyAsc, 8, () => {
    const period=7;
    const tr = [];
    for (let i=1; i<historyAsc.length; i++) tr.push(Math.abs(historyAsc[i].tong - historyAsc[i-1].tong));
    const atr = tr.slice(-period).reduce((a,b)=>a+b,0)/period;
    const lastChange = tr[tr.length-1];
    let prediction, confidence;
    if (lastChange > atr*1.5) { prediction='xiu'; confidence=60; }
    else if (lastChange < atr*0.5) { prediction='tai'; confidence=55; }
    else { prediction = historyAsc[historyAsc.length-1].ket_qua === 'tai' ? 'xiu' : 'tai'; confidence=45; }
    return { prediction, confidence, algorithm: 'ATR (7)' };
  });
}

// 7. ADX (7)
function algoADX(historyAsc) {
  return safeAlgo(historyAsc, 14, () => {
    const period=7;
    const dmPlus=[], dmMinus=[], trArr=[];
    for (let i=1; i<historyAsc.length; i++) {
      const up=historyAsc[i].tong-historyAsc[i-1].tong, down=historyAsc[i-1].tong-historyAsc[i].tong;
      dmPlus.push(up>down && up>0 ? up : 0);
      dmMinus.push(down>up && down>0 ? down : 0);
      trArr.push(Math.abs(historyAsc[i].tong-historyAsc[i-1].tong));
    }
    const sma = arr => arr.slice(-period).reduce((a,b)=>a+b,0)/period;
    const atr = sma(trArr);
    if (atr===0) return { prediction: historyAsc[historyAsc.length-1].ket_qua, confidence:40, algorithm:'ADX (7)' };
    const diPlus = (sma(dmPlus)/atr)*100, diMinus = (sma(dmMinus)/atr)*100;
    return { prediction: diPlus>diMinus ? 'tai':'xiu', confidence:55, algorithm:'ADX (7)' };
  });
}

// 8. Parabolic SAR
function algoSAR(historyAsc) {
  return safeAlgo(historyAsc, 5, () => {
    let trend = historyAsc[0].tong < historyAsc[1].tong ? 'tai' : 'xiu';
    let sar = trend==='tai' ? Math.min(...historyAsc.slice(0,2).map(i=>i.tong)) : Math.max(...historyAsc.slice(0,2).map(i=>i.tong));
    let ep = trend==='tai' ? Math.max(...historyAsc.slice(0,2).map(i=>i.tong)) : Math.min(...historyAsc.slice(0,2).map(i=>i.tong));
    let af=0.02, maxAf=0.2;
    for (let i=2; i<historyAsc.length; i++) {
      const price = historyAsc[i].tong;
      sar = sar + af*(ep - sar);
      if ((trend==='tai' && price<sar) || (trend==='xiu' && price>sar)) {
        trend = trend==='tai' ? 'xiu':'tai';
        sar = ep; af=0.02; ep=price;
      } else {
        if (trend==='tai' && price>ep) { ep=price; af=Math.min(af+0.02, maxAf); }
        else if (trend==='xiu' && price<ep) { ep=price; af=Math.min(af+0.02, maxAf); }
      }
    }
    return { prediction: trend, confidence: 55, algorithm: 'Parabolic SAR' };
  });
}

// 9. Fractal Dimension
function algoFractal(historyAsc) {
  return safeAlgo(historyAsc, 15, () => {
    const x = historyAsc.map(i=>i.tong);
    const L = k => {
      let sum=0;
      for (let m=0;m<k;m++) {
        let len=0, cnt=0;
        for (let i=m; i+k<x.length; i+=k) { len+=Math.abs(x[i+k]-x[i]); cnt++; }
        if (cnt) sum += (len/cnt)*((x.length-1)/(cnt*k));
      }
      return sum/k;
    };
    const lengths = [1,2,3,4,5].map(k => Math.log(L(k)));
    const logK = [1,2,3,4,5].map(Math.log);
    const n=5, sumX=logK.reduce((a,b)=>a+b), sumY=lengths.reduce((a,b)=>a+b);
    const slope = (n*logK.reduce((s,x,i)=>s+x*lengths[i],0)-sumX*sumY)/(n*logK.reduce((s,x)=>s+x*x,0)-sumX*sumX);
    return { prediction: slope<1.5 ? 'tai' : 'xiu', confidence:60, algorithm:'Fractal' };
  });
}

// 10. Entropy Shannon
function algoEntropy(historyAsc) {
  return safeAlgo(historyAsc, 20, () => {
    const seq = historyAsc.slice(-20).map(i=>i.ket_qua).join('');
    const freq = {};
    for (let c of seq) freq[c] = (freq[c]||0)+1;
    let entropy=0;
    for (let k in freq) { const p=freq[k]/seq.length; entropy -= p*Math.log2(p); }
    const norm = entropy/Math.log2(2);
    if (norm>0.8) return { prediction: historyAsc[historyAsc.length-1].ket_qua==='tai'?'xiu':'tai', confidence:60, algorithm:'Entropy cao' };
    return { prediction: historyAsc[historyAsc.length-1].ket_qua, confidence:50, algorithm:'Entropy thấp' };
  });
}

// 11. Poisson
function algoPoisson(historyAsc) {
  return safeAlgo(historyAsc, 15, () => {
    const slice = historyAsc.slice(-15);
    const mean = slice.reduce((s,i)=>s+i.tong,0)/15;
    const cdf = (k,lam) => { let s=0, t=Math.exp(-lam); for (let i=0;i<=k;i++) { s+=t; t*=lam/(i+1); } return s; };
    const probTai = 1 - cdf(10, mean);
    return { prediction: probTai>0.5?'tai':'xiu', confidence:Math.min(70, Math.abs(probTai-0.5)*200), algorithm:'Poisson (15)' };
  });
}

// 12. Hồi quy tuyến tính
function algoLinReg(historyAsc) {
  return safeAlgo(historyAsc, 12, () => {
    const period=12, n=period;
    const x=[], y=[];
    for (let i=historyAsc.length-period; i<historyAsc.length; i++) { x.push(i-(historyAsc.length-period)); y.push(historyAsc[i].tong); }
    const sumX=x.reduce((a,b)=>a+b), sumY=y.reduce((a,b)=>a+b);
    const sumXY=x.reduce((s,xi,i)=>s+xi*y[i],0), sumX2=x.reduce((s,xi)=>s+xi*xi,0);
    const slope = (n*sumXY - sumX*sumY) / (n*sumX2 - sumX*sumX);
    return { prediction: slope>0?'tai':'xiu', confidence:Math.min(65, Math.abs(slope)*10), algorithm:'Linear Reg (12)' };
  });
}

// 13. Markov bậc 1
function algoMarkov1(historyAsc) {
  return safeAlgo(historyAsc, 2, () => {
    const lastState = historyAsc[historyAsc.length-1].ket_qua;
    const trans = { tai:{tai:0,xiu:0}, xiu:{tai:0,xiu:0} };
    for (let i=0;i<historyAsc.length-1;i++) trans[historyAsc[i].ket_qua][historyAsc[i+1].ket_qua]++;
    const total = trans[lastState].tai + trans[lastState].xiu;
    if (total===0) return { prediction: lastState==='tai'?'xiu':'tai', confidence:50, algorithm:'Markov 1' };
    const probTai = trans[lastState].tai/total, probXiu = trans[lastState].xiu/total;
    const prediction = probTai>probXiu?'tai':(probXiu>probTai?'xiu':(lastState==='tai'?'xiu':'tai'));
    return { prediction, confidence:Math.max(probTai,probXiu)*100, algorithm:'Markov 1' };
  });
}

// 14. Fibonacci Break
function algoFibBreak(historyAsc) {
  return safeAlgo(historyAsc, 2, () => {
    const seq = historyAsc.map(i=>i.ket_qua);
    let current=1;
    for (let i=1;i<seq.length;i++) { if(seq[i]===seq[i-1]) current++; else current=1; }
    const last = historyAsc[historyAsc.length-1].ket_qua;
    if ([1,2,3,5,8].includes(current)) return { prediction: last==='tai'?'xiu':'tai', confidence:65, algorithm:'Fibonacci Break' };
    return { prediction: last, confidence:50, algorithm:'Fibonacci' };
  });
}

// 15. Nến Nhật 3 phiên (Sao Mai/Sao Hôm)
function algoCandles(historyAsc) {
  return safeAlgo(historyAsc, 3, () => {
    const [p1,p2,p3] = historyAsc.slice(-3);
    if (p1.ket_qua==='xiu' && p1.tong<=7 && p2.tong<=7 && p3.ket_qua==='tai' && p3.tong>=14) return { prediction:'tai', confidence:70, algorithm:'Sao Mai' };
    if (p1.ket_qua==='tai' && p1.tong>=14 && p2.tong>=14 && p3.ket_qua==='xiu' && p3.tong<=7) return { prediction:'xiu', confidence:70, algorithm:'Sao Hôm' };
    return { prediction: p3.ket_qua==='tai'?'xiu':'tai', confidence:50, algorithm:'Nến 3 phiên' };
  });
}

// 16. Tần suất cân bằng (12 phiên)
function algoFreqBalance(historyAsc) {
  return safeAlgo(historyAsc, 12, () => {
    const recent = historyAsc.slice(-12);
    let tai=0, xiu=0;
    recent.forEach(i=> i.ket_qua==='tai'?tai++:xiu++);
    const last = historyAsc[historyAsc.length-1].ket_qua;
    const prediction = tai<xiu?'tai':(tai>xiu?'xiu':(last==='tai'?'xiu':'tai'));
    const confidence = Math.abs(tai-xiu)/12*100;
    return { prediction, confidence, algorithm:'Cân bằng (12)' };
  });
}

// 17. Xu hướng tổng điểm (3 phiên)
function algoTotalTrend(historyAsc) {
  return safeAlgo(historyAsc, 6, () => {
    const sumLast = historyAsc.slice(-3).reduce((s,i)=>s+i.tong,0);
    const sumPrev = historyAsc.slice(-6,-3).reduce((s,i)=>s+i.tong,0);
    const prediction = sumLast>sumPrev?'tai':(sumLast<sumPrev?'xiu':historyAsc[historyAsc.length-1].ket_qua);
    return { prediction, confidence:Math.min(70, Math.abs(sumLast-sumPrev)/2), algorithm:'Xu hướng tổng (3)' };
  });
}

// 18. Phân tích xúc xắc chẵn/lẻ
function algoDiceEvenOdd(historyAsc) {
  return safeAlgo(historyAsc, 10, () => {
    const last10 = historyAsc.slice(-10);
    let even=0;
    last10.forEach(i=> [i.xuc_xac_1,i.xuc_xac_2,i.xuc_xac_3].forEach(d=>{ if(d%2===0) even++; }));
    const ratio = even/(last10.length*3);
    const last = historyAsc[historyAsc.length-1].ket_qua;
    if (ratio>0.6) return { prediction:'xiu', confidence:55, algorithm:'Xúc xắc chẵn/lẻ' };
    if (ratio<0.4) return { prediction:'tai', confidence:55, algorithm:'Xúc xắc chẵn/lẻ' };
    return { prediction: last==='tai'?'xiu':'tai', confidence:50, algorithm:'Xúc xắc chẵn/lẻ' };
  });
}

// 19. Đảo phiên cuối (tính xác suất lịch sử)
function algoInvert(historyAsc) {
  return safeAlgo(historyAsc, 2, () => {
    const latest = historyAsc[historyAsc.length-1].ket_qua;
    let correct=0, total=0;
    for (let i=0;i<historyAsc.length-1;i++) {
      if ((historyAsc[i].ket_qua==='tai' && historyAsc[i+1].ket_qua==='xiu')||(historyAsc[i].ket_qua==='xiu' && historyAsc[i+1].ket_qua==='tai')) correct++;
      total++;
    }
    const prediction = latest==='tai'?'xiu':'tai';
    return { prediction, confidence: total>0?(correct/total)*100:50, algorithm:'Đảo phiên cuối' };
  });
}

// 20. Keltner Channel (10,1.5)
function algoKeltner(historyAsc) {
  return safeAlgo(historyAsc, 10, () => {
    const prices = historyAsc.slice(-10).map(i=>i.tong);
    const ma = prices.reduce((a,b)=>a+b,0)/10;
    const tr = [];
    for (let i=1;i<prices.length;i++) tr.push(Math.abs(prices[i]-prices[i-1]));
    const atr = tr.reduce((a,b)=>a+b,0)/tr.length;
    const upper = ma+1.5*atr, lower = ma-1.5*atr;
    const last = prices[prices.length-1];
    if (last>upper) return { prediction:'xiu', confidence:60, algorithm:'Keltner (10)' };
    if (last<lower) return { prediction:'tai', confidence:60, algorithm:'Keltner (10)' };
    return { prediction: last>ma?'tai':'xiu', confidence:50, algorithm:'Keltner (10)' };
  });
}

// 21. Mô hình 2 đỉnh/đáy
function algoDoubleTB(historyAsc) {
  return safeAlgo(historyAsc, 10, () => {
    const slice = historyAsc.slice(-10);
    const tops=[], bottoms=[];
    for (let i=1;i<slice.length-1;i++) {
      if (slice[i].tong>slice[i-1].tong && slice[i].tong>slice[i+1].tong) tops.push(slice[i].tong);
      if (slice[i].tong<slice[i-1].tong && slice[i].tong<slice[i+1].tong) bottoms.push(slice[i].tong);
    }
    if (tops.length>=2 && Math.abs(tops[tops.length-1]-tops[tops.length-2])<2) return { prediction:'xiu', confidence:65, algorithm:'Double Top' };
    if (bottoms.length>=2 && Math.abs(bottoms[bottoms.length-1]-bottoms[bottoms.length-2])<2) return { prediction:'tai', confidence:65, algorithm:'Double Bottom' };
    return { prediction: historyAsc[historyAsc.length-1].ket_qua==='tai'?'xiu':'tai', confidence:50, algorithm:'Double Pattern' };
  });
}

// 22. Biến động giá trị xúc xắc 1
function algoDice1Vol(historyAsc) {
  return safeAlgo(historyAsc, 5, () => {
    const last5 = historyAsc.slice(-5);
    const std = Math.sqrt(last5.reduce((s,i)=>s+Math.pow(i.xuc_xac_1 - last5.reduce((a,b)=>a+b.xuc_xac_1,0)/5,2),0)/5);
    if (std>1.5) return { prediction:'tai', confidence:55, algorithm:'Xúc xắc 1 biến động' };
    return { prediction:'xiu', confidence:55, algorithm:'Xúc xắc 1 ổn định' };
  });
}

// 23. Tương quan xúc xắc 1 & 3
function algoCorr13(historyAsc) {
  return safeAlgo(historyAsc, 12, () => {
    const slice = historyAsc.slice(-12);
    const x1=slice.map(i=>i.xuc_xac_1), x3=slice.map(i=>i.xuc_xac_3);
    const n=x1.length, sum1=x1.reduce((a,b)=>a+b), sum3=x3.reduce((a,b)=>a+b);
    const r = (n*x1.reduce((s,v,i)=>s+v*x3[i],0)-sum1*sum3)/(Math.sqrt(n*x1.reduce((s,v)=>s+v*v,0)-sum1*sum1)*Math.sqrt(n*x3.reduce((s,v)=>s+v*v,0)-sum3*sum3));
    if (r>0.3) return { prediction:'tai', confidence:55, algorithm:'Corr 1-3 +' };
    if (r<-0.3) return { prediction:'xiu', confidence:55, algorithm:'Corr 1-3 -' };
    return { prediction: historyAsc[historyAsc.length-1].ket_qua==='tai'?'xiu':'tai', confidence:45, algorithm:'Corr 1-3' };
  });
}

// 24. Chu kỳ 2 phiên lặp
function algoCycle2(historyAsc) {
  return safeAlgo(historyAsc, 6, () => {
    const pattern = historyAsc[historyAsc.length-2].ket_qua + historyAsc[historyAsc.length-1].ket_qua;
    let count=0, lastIdx=-1;
    for (let i=0;i<historyAsc.length-1;i++) {
      if (historyAsc[i].ket_qua+historyAsc[i+1].ket_qua===pattern) { count++; lastIdx=i; }
    }
    if (count>=3 && lastIdx+2<historyAsc.length) return { prediction: historyAsc[lastIdx+2].ket_qua, confidence:65, algorithm:'Cycle 2 lặp' };
    return { prediction: pattern[1]==='t'?'xiu':'tai', confidence:50, algorithm:'Cycle 2' };
  });
}

// 25. Tổng hai phiên liên tiếp
function algoTwoSum(historyAsc) {
  return safeAlgo(historyAsc, 3, () => {
    const sum = historyAsc[historyAsc.length-1].tong + historyAsc[historyAsc.length-2].tong;
    if (sum>22) return { prediction:'xiu', confidence:60, algorithm:'Two Sum high' };
    if (sum<9) return { prediction:'tai', confidence:60, algorithm:'Two Sum low' };
    return { prediction: sum>14?'tai':'xiu', confidence:50, algorithm:'Two Sum' };
  });
}

// Danh sách tất cả thuật toán (25 cái)
const ALGORITHMS = [
  algoEMACross, algoMACD, algoRSI, algoBollinger, algoIchimoku,
  algoATR, algoADX, algoSAR, algoFractal, algoEntropy,
  algoPoisson, algoLinReg, algoMarkov1, algoFibBreak, algoCandles,
  algoFreqBalance, algoTotalTrend, algoDiceEvenOdd, algoInvert, algoKeltner,
  algoDoubleTB, algoDice1Vol, algoCorr13, algoCycle2, algoTwoSum
];

// ==================== BRAIN VIP (BÌNH CHỌN CÓ TRỌNG SỐ) ====================
function brainVIP(historyAsc) {
  const results = ALGORITHMS.map(fn => fn(historyAsc));
  const votes = { tai: 0, xiu: 0 };
  let totalWeight = 0;
  results.forEach(r => {
    const weight = r.confidence / 100;
    votes[r.prediction] += weight;
    totalWeight += weight;
  });
  const last = historyAsc[historyAsc.length-1].ket_qua;
  let prediction, confidence;
  if (votes.tai > votes.xiu) {
    prediction = 'tai';
    confidence = (votes.tai / totalWeight) * 100;
  } else if (votes.xiu > votes.tai) {
    prediction = 'xiu';
    confidence = (votes.xiu / totalWeight) * 100;
  } else {
    prediction = last === 'tai' ? 'xiu' : 'tai';
    confidence = 50;
  }
  return {
    prediction,
    confidence: +confidence.toFixed(2),
    algorithmsUsed: results.map(r => ({ name: r.algorithm, predict: r.prediction, conf: r.confidence })),
    totalAlgorithms: results.length
  };
}

// ==================== DỰ ĐOÁN & LƯU TRỮ ====================
function predictAndSave(historyList, game) {
  if (!historyList || historyList.length === 0) throw new Error('History empty');
  const sortedAsc = [...historyList].sort((a, b) => a.phien - b.phien);
  const latest = historyList[0]; // API đã sắp xếp mới nhất đầu
  if (!latest || latest.phien === undefined) throw new Error('Invalid history data');
  
  const predictedPhien = latest.phien + 1;
  let brain;
  try {
    brain = brainVIP(sortedAsc);
  } catch (err) {
    console.error('BrainVIP error:', err.message);
    // Fallback dự đoán ngược lại kết quả cuối cùng
    const lastKetQua = latest.ket_qua;
    brain = {
      prediction: lastKetQua === 'tai' ? 'xiu' : 'tai',
      confidence: 45,
      algorithmsUsed: [{ name: 'Fallback', predict: lastKetQua === 'tai' ? 'xiu' : 'tai', conf: 45 }],
      totalAlgorithms: 1
    };
  }
  const pattern = sortedAsc.slice(-20).map(item => item.ket_qua === 'tai' ? 'T' : 'X').join('');

  const newPred = {
    id: ++predictionIdCounter,
    game,
    predictedPhien,
    prediction: brain.prediction,
    confidence: brain.confidence,
    algorithmsUsed: brain.algorithmsUsed,
    totalAlgorithms: brain.totalAlgorithms,
    timestamp: new Date().toISOString(),
    status: 'pending',
    actualKetQua: null,
    checkedAt: null
  };
  predictions.push(newPred);

  // Kiểm tra xem phiên này đã có kết quả chưa
  const alreadyExist = historyList.find(h => h.phien === predictedPhien);
  if (alreadyExist) {
    newPred.actualKetQua = alreadyExist.ket_qua;
    newPred.status = (newPred.prediction === alreadyExist.ket_qua) ? 'correct' : 'incorrect';
    newPred.checkedAt = new Date().toISOString();
  }

  if (predictions.length > MAX_PREDICTIONS) {
    const sorted = [...predictions].sort((a, b) => b.timestamp - a.timestamp);
    predictions.length = 0;
    predictions.push(...sorted.slice(0, MAX_PREDICTIONS));
  }

  return {
    phien: latest.phien,
    xuc_xac_1: latest.xuc_xac_1,
    xuc_xac_2: latest.xuc_xac_2,
    xuc_xac_3: latest.xuc_xac_3,
    tong: latest.tong,
    ket_qua: latest.ket_qua,
    phien_hien_tai: predictedPhien,
    pattern,
    du_doan: brain.prediction,
    do_tin_cay: brain.confidence + '%',
    admin: ADMIN_NAME,
    update: formatTime(new Date()),
    thuat_toan_su_dung: brain.algorithmsUsed.slice(0, 10),
    total_algorithms: brain.totalAlgorithms,
    prediction_id: newPred.id
  };
}

// ==================== ENDPOINTS ====================
app.get('/', (req, res) => {
  res.json({
    message: '🚀 Tài Xỉu Siêu VIP Predictor',
    admin: ADMIN_NAME,
    uptime: Math.floor((Date.now() - startTime) / 1000) + 's',
    ping_count: pingCount,
    total_algorithms: ALGORITHMS.length,
    endpoints: {
      history_lc79: '/api/history/lc79',
      history_md5: '/api/history/taixiumd5',
      predict_lc79: '/api/predict/lc79',
      predict_md5: '/api/predict/taixiumd5',
      predictions_list: '/api/predictions/:game?status=pending|correct|incorrect',
      delete_predictions: '/api/predictions/:game (DELETE)',
      dashboard_lc79: '/dashboard/lc79',
      dashboard_md5: '/dashboard/taixiumd5',
      ping: '/ping'
    }
  });
});

app.get('/api/history/:game', async (req, res) => {
  const game = req.params.game === 'lc79' ? 'lc79' : 'md5';
  const apiUrl = game === 'lc79' ? API_URL_HU : API_URL_MD5;
  try {
    const data = await fetchHistory(apiUrl);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: `Failed to fetch data for ${game}`, details: err.message });
  }
});

app.get('/api/predict/:game', async (req, res) => {
  const game = req.params.game === 'lc79' ? 'lc79' : 'md5';
  const apiUrl = game === 'lc79' ? API_URL_HU : API_URL_MD5;
  try {
    const history = await fetchHistory(apiUrl);
    if (!history || history.length === 0) throw new Error('Empty history');
    const prediction = predictAndSave(history, game);
    res.json(prediction);
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate prediction', details: err.message });
  }
});

app.get('/api/predictions/:game', (req, res) => {
  const gameKey = req.params.game === 'lc79' ? 'lc79' : 'md5';
  const statusFilter = req.query.status;
  let filtered = predictions.filter(p => p.game === gameKey);
  if (statusFilter) filtered = filtered.filter(p => p.status === statusFilter);
  filtered.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  const total = predictions.filter(p => p.game === gameKey).length;
  const correct = predictions.filter(p => p.game === gameKey && p.status === 'correct').length;
  const incorrect = predictions.filter(p => p.game === gameKey && p.status === 'incorrect').length;
  const pending = predictions.filter(p => p.game === gameKey && p.status === 'pending').length;
  const accuracy = (correct + incorrect) > 0 ? (correct / (correct + incorrect) * 100).toFixed(2) + '%' : 'N/A';

  res.json({ game: gameKey, total, correct, incorrect, pending, accuracy, predictions: filtered });
});

app.delete('/api/predictions/:game', (req, res) => {
  const gameKey = req.params.game === 'lc79' ? 'lc79' : 'md5';
  let removed = 0;
  for (let i = predictions.length - 1; i >= 0; i--) {
    if (predictions[i].game === gameKey) {
      predictions.splice(i, 1);
      removed++;
    }
  }
  res.json({ message: `Deleted ${removed} predictions for ${gameKey}` });
});

app.get('/ping', (req, res) => {
  pingCount++;
  res.json({ ping_count: pingCount, time: formatTime(new Date()) });
});

// ==================== DASHBOARD ĐẸP ====================
app.get('/dashboard/:game', (req, res) => {
  const gameKey = req.params.game === 'lc79' ? 'lc79' : 'md5';
  const gameName = gameKey === 'lc79' ? 'Tài Xỉu Hũ' : 'Tài Xỉu MD5';
  
  const total = predictions.filter(p => p.game === gameKey).length;
  const correct = predictions.filter(p => p.game === gameKey && p.status === 'correct').length;
  const incorrect = predictions.filter(p => p.game === gameKey && p.status === 'incorrect').length;
  const pending = predictions.filter(p => p.game === gameKey && p.status === 'pending').length;
  const accuracy = (correct + incorrect) > 0 ? (correct / (correct + incorrect) * 100).toFixed(2) : 'N/A';
  const preds = predictions.filter(p => p.game === gameKey).sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  const recentPreds = preds.slice(0, 10).reverse();
  const chartLabels = recentPreds.map(p => '#' + p.predictedPhien);
  const chartData = recentPreds.map(p => p.prediction === 'tai' ? 1 : -1);
  const chartStatus = recentPreds.map(p => p.status === 'correct' ? 1 : (p.status === 'incorrect' ? -1 : 0));

  let html = `
  <!DOCTYPE html><html><head><meta charset="UTF-8"><title>Dashboard ${gameName} - ${ADMIN_NAME}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    body { font-family: 'Segoe UI', sans-serif; margin: 0; background: linear-gradient(135deg, #0f2027, #203a43, #2c5364); color: #fff; }
    .container { max-width: 1200px; margin: auto; padding: 20px; }
    h1 { text-align: center; font-size: 2.5em; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 15px; margin-bottom: 30px; }
    .stat-box { background: rgba(255,255,255,0.1); backdrop-filter: blur(10px); padding: 20px; border-radius: 15px; text-align: center; }
    .stat-box h3 { margin: 0; font-size: 14px; }
    .stat-box .value { font-size: 32px; font-weight: bold; }
    .correct { color: #4caf50; } .incorrect { color: #f44336; } .pending { color: #ff9800; }
    .chart-container { background: rgba(255,255,255,0.1); backdrop-filter: blur(10px); border-radius: 15px; padding: 20px; margin-bottom: 20px; }
    canvas { max-height: 300px; }
    .filter { margin-bottom: 20px; }
    button { padding: 10px 20px; border: none; border-radius: 25px; cursor: pointer; font-weight: bold; margin-right: 10px; background: rgba(255,255,255,0.2); color: #fff; }
    button.active, button:hover { background: #4caf50; }
    table { width: 100%; border-collapse: collapse; background: rgba(255,255,255,0.05); border-radius: 15px; overflow: hidden; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.1); }
    th { background: rgba(0,0,0,0.3); }
    .status-badge { padding: 5px 12px; border-radius: 20px; font-size: 12px; font-weight: bold; }
    .status-correct { background: #4caf50; } .status-incorrect { background: #f44336; } .status-pending { background: #ff9800; }
  </style></head><body>
  <div class="container">
    <h1>📊 Dashboard ${gameName}</h1>
    <p style="text-align:center">Admin: ${ADMIN_NAME} | Time: ${formatTime(new Date())} | Ping: ${pingCount}</p>
    <div class="stats">
      <div class="stat-box"><h3>Tổng</h3><div class="value">${total}</div></div>
      <div class="stat-box"><h3>Đúng</h3><div class="value correct">${correct}</div></div>
      <div class="stat-box"><h3>Sai</h3><div class="value incorrect">${incorrect}</div></div>
      <div class="stat-box"><h3>Chờ</h3><div class="value pending">${pending}</div></div>
      <div class="stat-box"><h3>Tỉ lệ đúng</h3><div class="value" style="color:#2196f3">${accuracy}</div></div>
    </div>
    <div class="chart-container"><canvas id="chart"></canvas></div>
    <div class="filter">
      <button class="active" onclick="filter('')">Tất cả</button>
      <button onclick="filter('pending')">Đang chờ</button>
      <button onclick="filter('correct')">Đúng</button>
      <button onclick="filter('incorrect')">Sai</button>
      <button onclick="location.reload()">🔄 Làm mới</button>
    </div>
    <table><thead><tr><th>ID</th><th>Phiên</th><th>Dự đoán</th><th>Thực tế</th><th>Trạng thái</th><th>Độ tin cậy</th><th>Thời gian</th></tr></thead><tbody>
  `;

  for (const p of preds) {
    const statusClass = `status-${p.status}`;
    const statusText = p.status === 'correct' ? 'Đúng' : (p.status === 'incorrect' ? 'Sai' : 'Chờ');
    html += `<tr>
      <td>${p.id}</td><td>${p.predictedPhien}</td><td><strong>${p.prediction.toUpperCase()}</strong></td>
      <td>${p.actualKetQua || '—'}</td><td><span class="status-badge ${statusClass}">${statusText}</span></td>
      <td>${p.confidence}%</td><td>${new Date(p.timestamp).toLocaleString()}</td>
    </tr>`;
  }

  html += `</tbody></table></div>
  <script>
    function filter(status) { const url = new URL(window.location); if (status) url.searchParams.set('status', status); else url.searchParams.delete('status'); window.location = url; }
    new Chart(document.getElementById('chart'), {
      type: 'line', data: {
        labels: ${JSON.stringify(chartLabels)},
        datasets: [
          { label: 'Dự đoán (Tài=1, Xỉu=-1)', data: ${JSON.stringify(chartData)}, borderColor: '#4caf50', yAxisID: 'y' },
          { label: 'Trạng thái (Đúng=1, Sai=-1, Chờ=0)', data: ${JSON.stringify(chartStatus)}, borderColor: '#ff9800', yAxisID: 'y1' }
        ]
      },
      options: { responsive: true, plugins: { legend: { labels: { color: '#fff' } } }, scales: { y: { ticks: { color: '#fff' } }, y1: { position: 'right', ticks: { color: '#fff' } }, x: { ticks: { color: '#fff' } } } }
    });
  </script></body></html>`;
  res.send(html);
});

// ==================== TỰ ĐỘNG PING MỖI PHÚT ====================
setInterval(() => {
  axios.get(`http://localhost:${PORT}/ping`).then(() => {
    console.log(`[PING] Tự ping thành công, tổng: ${pingCount}`);
  }).catch(() => {
    pingCount++;
    console.log(`[PING] Tăng thủ công, tổng: ${pingCount}`);
  });
}, 60000);

app.listen(PORT, () => {
  console.log(`✅ Server VIP chạy trên cổng ${PORT} – ${ALGORITHMS.length} thuật toán tinh hoa`);
});