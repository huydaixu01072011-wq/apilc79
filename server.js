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
    ket_qua: item.resultTruyenThong,
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

// ==================== TẤT CẢ THUẬT TOÁN (HƠN 100) ====================
// --- Nhóm cơ bản ---
function algorithmInvertLast(historyAsc) {
  const latest = historyAsc[historyAsc.length - 1];
  const prediction = latest.ket_qua === 'tai' ? 'xiu' : 'tai';
  let correct = 0, total = 0;
  for (let i = 0; i < historyAsc.length - 1; i++) {
    total++;
    if ((historyAsc[i].ket_qua === 'tai' && historyAsc[i + 1].ket_qua === 'xiu') ||
        (historyAsc[i].ket_qua === 'xiu' && historyAsc[i + 1].ket_qua === 'tai')) correct++;
  }
  const confidence = total > 0 ? (correct / total) * 100 : 50;
  return { prediction, confidence: +confidence.toFixed(2), algorithm: 'Đảo Phiên Cuối' };
}

function algorithmFollowStreak(historyAsc) {
  const len = historyAsc.length;
  if (len < 2) return { prediction: historyAsc[len - 1].ket_qua, confidence: 50, algorithm: 'Theo Cầu (thiếu dữ liệu)' };
  const lastTwoSame = historyAsc[len - 1].ket_qua === historyAsc[len - 2].ket_qua;
  const prediction = lastTwoSame ? historyAsc[len - 1].ket_qua : (historyAsc[len - 1].ket_qua === 'tai' ? 'xiu' : 'tai');
  let correct = 0, total = 0;
  for (let i = 0; i < len - 2; i++) {
    total++;
    const currentTwoSame = historyAsc[i].ket_qua === historyAsc[i + 1].ket_qua;
    const expectedNext = currentTwoSame ? historyAsc[i + 1].ket_qua : (historyAsc[i + 1].ket_qua === 'tai' ? 'xiu' : 'tai');
    if (historyAsc[i + 2].ket_qua === expectedNext) correct++;
  }
  const confidence = total > 0 ? (correct / total) * 100 : 50;
  return { prediction, confidence: +confidence.toFixed(2), algorithm: 'Theo Cầu 2 Phiên' };
}

function algorithmBreakLong(historyAsc, threshold = 3) {
  const len = historyAsc.length;
  if (len < threshold) return { prediction: historyAsc[len - 1].ket_qua, confidence: 30, algorithm: `Bẻ Cầu Dài (thiếu dữ liệu, cần ≥${threshold})` };
  let streak = 1;
  for (let i = len - 2; i >= 0; i--) {
    if (historyAsc[i].ket_qua === historyAsc[i + 1].ket_qua) streak++;
    else break;
  }
  const prediction = streak >= threshold ? (historyAsc[len - 1].ket_qua === 'tai' ? 'xiu' : 'tai') : historyAsc[len - 1].ket_qua;
  const confidence = streak >= threshold ? Math.min(80, 50 + streak * 10) : 40;
  return { prediction, confidence, algorithm: `Bẻ Cầu Dài (≥${threshold})` };
}

function makeFrequencyBalance(N) {
  return (historyAsc) => {
    const recent = historyAsc.slice(-N);
    let taiCount = 0, xiuCount = 0;
    recent.forEach(item => { if (item.ket_qua === 'tai') taiCount++; else xiuCount++; });
    const last = historyAsc[historyAsc.length - 1];
    const prediction = taiCount < xiuCount ? 'tai' : (taiCount > xiuCount ? 'xiu' : (last.ket_qua === 'tai' ? 'xiu' : 'tai'));
    const confidence = Math.abs(taiCount - xiuCount) / N * 100;
    return { prediction, confidence: +confidence.toFixed(2), algorithm: `Cân Bằng Tần Suất (${N} phiên)` };
  };
}

function algorithmTotalTrend(historyAsc, N = 3) {
  const len = historyAsc.length;
  if (len < N * 2) return { prediction: historyAsc[len - 1].ket_qua, confidence: 40, algorithm: `Xu Hướng Tổng Điểm (${N} phiên)` };
  const sumLast = historyAsc.slice(-N).reduce((s, i) => s + i.tong, 0);
  const sumPrev = historyAsc.slice(-2 * N, -N).reduce((s, i) => s + i.tong, 0);
  const prediction = sumLast > sumPrev ? 'tai' : (sumLast < sumPrev ? 'xiu' : (historyAsc[len - 1].ket_qua === 'tai' ? 'xiu' : 'tai'));
  const confidence = Math.min(75, Math.abs(sumLast - sumPrev) / N);
  return { prediction, confidence: +confidence.toFixed(2), algorithm: `Xu Hướng Tổng Điểm (${N} phiên)` };
}

function algorithmEvenOddTrend(historyAsc) {
  const len = historyAsc.length;
  if (len < 4) return { prediction: historyAsc[len - 1].ket_qua, confidence: 40, algorithm: 'Chẵn Lẻ' };
  const recentEven = historyAsc[len - 1].tong % 2 === 0;
  const prevEven = historyAsc[len - 2].tong % 2 === 0;
  let prediction;
  if (recentEven && prevEven) prediction = 'tai';
  else if (!recentEven && !prevEven) prediction = 'xiu';
  else prediction = recentEven ? 'xiu' : 'tai';
  return { prediction, confidence: 55, algorithm: 'Chẵn Lẻ' };
}

function algorithmMirrorPattern(historyAsc, patternLength = 5) {
  const len = historyAsc.length;
  if (len < patternLength + 5) return { prediction: historyAsc[len - 1].ket_qua, confidence: 30, algorithm: 'Sao Chép Mẫu (thiếu dữ liệu)' };
  const pattern = historyAsc.slice(-patternLength).map(i => i.ket_qua[0].toUpperCase()).join('');
  let bestMatchIdx = -1;
  for (let i = 0; i <= len - patternLength - 1; i++) {
    const sub = historyAsc.slice(i, i + patternLength).map(i => i.ket_qua[0].toUpperCase()).join('');
    if (sub === pattern) {
      bestMatchIdx = i;
      break;
    }
  }
  if (bestMatchIdx === -1) {
    return { prediction: historyAsc[len - 1].ket_qua === 'tai' ? 'xiu' : 'tai', confidence: 45, algorithm: 'Sao Chép Mẫu (không khớp)' };
  }
  const nextAfterMatch = historyAsc[bestMatchIdx + patternLength];
  return {
    prediction: nextAfterMatch.ket_qua,
    confidence: 65,
    algorithm: `Sao Chép Mẫu Lịch Sử (${patternLength})`
  };
}

function algorithmStochasticOscillator(historyAsc) {
  const last3 = historyAsc.slice(-3);
  const allTai = last3.every(i => i.tong >= 11);
  const allXiu = last3.every(i => i.tong <= 10);
  if (allTai) return { prediction: 'xiu', confidence: 70, algorithm: 'Stochastic Oscillator' };
  if (allXiu) return { prediction: 'tai', confidence: 70, algorithm: 'Stochastic Oscillator' };
  return { prediction: historyAsc[historyAsc.length - 1].ket_qua === 'tai' ? 'xiu' : 'tai', confidence: 50, algorithm: 'Stochastic Oscillator' };
}

function algorithmMartingaleReverse(historyAsc) {
  const len = historyAsc.length;
  if (len < 4) return { prediction: 'tai', confidence: 30, algorithm: 'Martingale Reverse (thiếu dữ liệu)' };
  const seq = historyAsc.slice(-4).map(i => i.ket_qua);
  if (seq[0] !== seq[1] && seq[1] !== seq[2]) {
    return { prediction: seq[3] === 'tai' ? 'xiu' : 'tai', confidence: 60, algorithm: 'Martingale Reverse (kích hoạt)' };
  }
  return { prediction: seq[3], confidence: 40, algorithm: 'Martingale Reverse (không kích hoạt)' };
}

function algorithmMarkovChain1(historyAsc) {
  const len = historyAsc.length;
  if (len < 2) return { prediction: 'tai', confidence: 50, algorithm: 'Markov Bậc 1' };
  const lastState = historyAsc[len - 1].ket_qua;
  const trans = { tai: { tai: 0, xiu: 0 }, xiu: { tai: 0, xiu: 0 } };
  for (let i = 0; i < len - 1; i++) {
    const from = historyAsc[i].ket_qua;
    const to = historyAsc[i + 1].ket_qua;
    trans[from][to]++;
  }
  const total = trans[lastState].tai + trans[lastState].xiu;
  if (total === 0) return { prediction: lastState === 'tai' ? 'xiu' : 'tai', confidence: 50, algorithm: 'Markov Bậc 1' };
  const probTai = trans[lastState].tai / total;
  const probXiu = trans[lastState].xiu / total;
  const prediction = probTai > probXiu ? 'tai' : (probXiu > probTai ? 'xiu' : (lastState === 'tai' ? 'xiu' : 'tai'));
  const confidence = Math.max(probTai, probXiu) * 100;
  return { prediction, confidence: +confidence.toFixed(2), algorithm: 'Markov Bậc 1' };
}

function algorithmMarkovChain2(historyAsc) {
  const len = historyAsc.length;
  if (len < 3) return { prediction: historyAsc[len - 1].ket_qua, confidence: 50, algorithm: 'Markov Bậc 2' };
  const lastTwo = historyAsc[len - 2].ket_qua + historyAsc[len - 1].ket_qua;
  const trans = {};
  for (let i = 0; i < len - 2; i++) {
    const from = historyAsc[i].ket_qua + historyAsc[i + 1].ket_qua;
    const to = historyAsc[i + 2].ket_qua;
    if (!trans[from]) trans[from] = { tai: 0, xiu: 0 };
    trans[from][to]++;
  }
  if (!trans[lastTwo]) return { prediction: historyAsc[len - 1].ket_qua === 'tai' ? 'xiu' : 'tai', confidence: 50, algorithm: 'Markov Bậc 2' };
  const total = trans[lastTwo].tai + trans[lastTwo].xiu;
  if (total === 0) return { prediction: historyAsc[len - 1].ket_qua === 'tai' ? 'xiu' : 'tai', confidence: 50, algorithm: 'Markov Bậc 2' };
  const probTai = trans[lastTwo].tai / total;
  const probXiu = trans[lastTwo].xiu / total;
  const prediction = probTai > probXiu ? 'tai' : (probXiu > probTai ? 'xiu' : (historyAsc[len - 1].ket_qua === 'tai' ? 'xiu' : 'tai'));
  const confidence = Math.max(probTai, probXiu) * 100;
  return { prediction, confidence: +confidence.toFixed(2), algorithm: 'Markov Bậc 2' };
}

function algorithmRSITong(historyAsc, period = 14) {
  const len = historyAsc.length;
  if (len < period + 1) return { prediction: historyAsc[len - 1].ket_qua, confidence: 40, algorithm: `RSI Tổng Điểm (${period})` };
  const changes = [];
  for (let i = len - period; i < len; i++) {
    changes.push(historyAsc[i].tong - historyAsc[i - 1].tong);
  }
  let avgGain = 0, avgLoss = 0;
  changes.forEach(c => {
    if (c > 0) avgGain += c;
    else avgLoss += Math.abs(c);
  });
  avgGain /= period;
  avgLoss /= period;
  if (avgLoss === 0) return { prediction: 'tai', confidence: 80, algorithm: `RSI Tổng Điểm (${period})` };
  const rs = avgGain / avgLoss;
  const rsi = 100 - (100 / (1 + rs));
  const prediction = rsi > 50 ? 'tai' : (rsi < 50 ? 'xiu' : (historyAsc[len - 1].ket_qua === 'tai' ? 'xiu' : 'tai'));
  const confidence = Math.min(80, Math.abs(rsi - 50) + 40);
  return { prediction, confidence: +confidence.toFixed(2), algorithm: `RSI Tổng Điểm (${period})` };
}

function algorithmBollingerBands(historyAsc, period = 20, multiplier = 2) {
  const len = historyAsc.length;
  if (len < period) return { prediction: historyAsc[len - 1].ket_qua, confidence: 40, algorithm: `Bollinger Bands (${period})` };
  const prices = historyAsc.slice(-period).map(i => i.tong);
  const ma = prices.reduce((a, b) => a + b, 0) / period;
  const variance = prices.reduce((a, b) => a + Math.pow(b - ma, 2), 0) / period;
  const std = Math.sqrt(variance);
  const upper = ma + multiplier * std;
  const lower = ma - multiplier * std;
  const lastPrice = prices[prices.length - 1];
  let prediction;
  if (lastPrice >= upper) prediction = 'xiu';
  else if (lastPrice <= lower) prediction = 'tai';
  else prediction = lastPrice > ma ? 'tai' : 'xiu';
  return { prediction, confidence: 55, algorithm: `Bollinger Bands (${period})` };
}

function algorithmFibonacciRetracement(historyAsc) {
  const len = historyAsc.length;
  if (len < 10) return { prediction: historyAsc[len - 1].ket_qua, confidence: 40, algorithm: 'Fibonacci Retracement' };
  const last10 = historyAsc.slice(-10);
  let trend = 0;
  for (const item of last10) {
    if (item.ket_qua === 'tai') trend++;
    else trend--;
  }
  if (Math.abs(trend) >= 6) {
    return { prediction: trend > 0 ? 'xiu' : 'tai', confidence: 65, algorithm: 'Fibonacci Retracement' };
  }
  return { prediction: historyAsc[len - 1].ket_qua === 'tai' ? 'xiu' : 'tai', confidence: 50, algorithm: 'Fibonacci Retracement' };
}

function algorithmCandlestickPattern(historyAsc) {
  const len = historyAsc.length;
  if (len < 3) return { prediction: historyAsc[len - 1].ket_qua, confidence: 40, algorithm: 'Mẫu Nến' };
  const prev2 = historyAsc[len - 2];
  const prev1 = historyAsc[len - 1];
  let prediction;
  if (prev2.ket_qua === 'tai' && prev2.tong >= 14 && prev1.ket_qua === 'xiu' && prev1.tong <= 7) prediction = 'xiu';
  else if (prev2.ket_qua === 'xiu' && prev2.tong <= 6 && prev1.ket_qua === 'tai' && prev1.tong >= 15) prediction = 'tai';
  else prediction = prev1.ket_qua === 'tai' ? 'xiu' : 'tai';
  return { prediction, confidence: 55, algorithm: 'Mẫu Nến' };
}

function algorithmEMACross(historyAsc, fastPeriod = 5, slowPeriod = 10) {
  const len = historyAsc.length;
  if (len < slowPeriod + 1) return { prediction: historyAsc[len-1].ket_qua, confidence: 40, algorithm: `EMA Cross (${fastPeriod}/${slowPeriod})` };
  const prices = historyAsc.map(i => i.tong);
  const ema = (data, period) => {
    const k = 2 / (period + 1);
    let ema = data[0];
    for (let i = 1; i < data.length; i++) ema = data[i] * k + ema * (1 - k);
    return ema;
  };
  const fastEMA = ema(prices.slice(-fastPeriod), fastPeriod);
  const slowEMA = ema(prices.slice(-slowPeriod), slowPeriod);
  let prediction;
  if (fastEMA > slowEMA) prediction = 'tai';
  else if (fastEMA < slowEMA) prediction = 'xiu';
  else prediction = historyAsc[len-1].ket_qua === 'tai' ? 'xiu' : 'tai';
  return { prediction, confidence: Math.min(75, Math.abs(fastEMA - slowEMA) * 10), algorithm: `EMA Cross (${fastPeriod}/${slowPeriod})` };
}

function algorithmMACD(historyAsc, fast=6, slow=13, signal=5) {
  const len = historyAsc.length;
  if (len < slow + signal) return { prediction: historyAsc[len-1].ket_qua, confidence: 40, algorithm: `MACD (${fast},${slow},${signal})` };
  const prices = historyAsc.map(i => i.tong);
  const ema = (data, period) => {
    const k = 2 / (period + 1);
    let arr = [data[0]];
    for (let i = 1; i < data.length; i++) arr.push(data[i] * k + arr[i-1] * (1 - k));
    return arr;
  };
  const emaFast = ema(prices, fast);
  const emaSlow = ema(prices, slow);
  const macdLine = emaFast.map((v, i) => v - emaSlow[i]);
  const signalLine = ema(macdLine.slice(-signal*2), signal);
  const lastMACD = macdLine[macdLine.length-1];
  const lastSignal = signalLine[signalLine.length-1];
  let prediction;
  if (lastMACD > lastSignal) prediction = 'tai';
  else if (lastMACD < lastSignal) prediction = 'xiu';
  else prediction = historyAsc[len-1].ket_qua === 'tai' ? 'xiu' : 'tai';
  return { prediction, confidence: 55 + Math.min(20, Math.abs(lastMACD - lastSignal)*5), algorithm: `MACD (${fast},${slow},${signal})` };
}

function algorithmBinomialBalance(historyAsc, N=20) {
  const recent = historyAsc.slice(-N);
  const taiCount = recent.filter(i => i.ket_qua === 'tai').length;
  const expected = N/2;
  const deviation = taiCount - expected;
  let prediction;
  if (deviation > N*0.25) prediction = 'xiu';
  else if (deviation < -N*0.25) prediction = 'tai';
  else prediction = historyAsc[historyAsc.length-1].ket_qua === 'tai' ? 'xiu' : 'tai';
  const confidence = Math.min(80, 50 + Math.abs(deviation) * (60/(N/2)));
  return { prediction, confidence: +confidence.toFixed(2), algorithm: `Cân bằng nhị thức (${N})` };
}

function algorithmDiceEvenOdd(historyAsc) {
  const last10 = historyAsc.slice(-10);
  let evenCount = 0;
  for (const item of last10) {
    [item.xuc_xac_1, item.xuc_xac_2, item.xuc_xac_3].forEach(d => { if (d % 2 === 0) evenCount++; });
  }
  const totalDice = last10.length * 3;
  const ratio = evenCount / totalDice;
  const last = historyAsc[historyAsc.length-1];
  let prediction;
  if (ratio > 0.6) prediction = 'xiu';
  else if (ratio < 0.4) prediction = 'tai';
  else prediction = last.ket_qua === 'tai' ? 'xiu' : 'tai';
  return { prediction, confidence: 55, algorithm: 'Xúc xắc Chẵn/Lẻ' };
}

function algorithmCandlestick3(historyAsc) {
  const len = historyAsc.length;
  if (len < 3) return { prediction: historyAsc[len-1].ket_qua, confidence: 40, algorithm: 'Nến 3 phiên' };
  const p1 = historyAsc[len-3];
  const p2 = historyAsc[len-2];
  const p3 = historyAsc[len-1];
  if (p1.ket_qua === 'xiu' && p1.tong <= 7 && p2.tong <= 7 && p3.ket_qua === 'tai' && p3.tong >= 14)
    return { prediction: 'tai', confidence: 70, algorithm: 'Sao Mai' };
  if (p1.ket_qua === 'tai' && p1.tong >= 14 && p2.tong >= 14 && p3.ket_qua === 'xiu' && p3.tong <= 7)
    return { prediction: 'xiu', confidence: 70, algorithm: 'Sao Hôm' };
  return { prediction: p3.ket_qua === 'tai' ? 'xiu' : 'tai', confidence: 50, algorithm: 'Nến 3 phiên' };
}

function algorithmMovingAverageThreshold(historyAsc, period=10) {
  const len = historyAsc.length;
  if (len < period) return { prediction: historyAsc[len-1].ket_qua, confidence: 40, algorithm: `MA Ngưỡng (${period})` };
  const avg = historyAsc.slice(-period).reduce((s, i) => s + i.tong, 0) / period;
  const prediction = avg > 10.5 ? 'tai' : 'xiu';
  return { prediction, confidence: Math.min(75, Math.abs(avg - 10.5) * 10), algorithm: `MA Ngưỡng (${period})` };
}

function algorithmStdDev(historyAsc, period=10) {
  const slice = historyAsc.slice(-period);
  if (slice.length < 2) return { prediction: historyAsc[historyAsc.length-1].ket_qua, confidence: 40, algorithm: `Std Dev (${period})` };
  const values = slice.map(i => i.tong);
  const mean = values.reduce((a,b)=>a+b,0)/values.length;
  const variance = values.reduce((s,v)=>s+Math.pow(v-mean,2),0)/values.length;
  const std = Math.sqrt(variance);
  const last = historyAsc[historyAsc.length-1];
  if (std > 3) return { prediction: last.ket_qua, confidence: 60, algorithm: `Std Dev cao (${period})` };
  else return { prediction: last.ket_qua === 'tai' ? 'xiu' : 'tai', confidence: 55, algorithm: `Std Dev thấp (${period})` };
}

function algorithmDiceComponentTrend(historyAsc) {
  const len = historyAsc.length;
  if (len < 5) return { prediction: historyAsc[len-1].ket_qua, confidence: 40, algorithm: 'Xu hướng Xúc Xắc' };
  const last = historyAsc[len-1];
  const diceAvg = (last.xuc_xac_1 + last.xuc_xac_2 + last.xuc_xac_3)/3;
  if (diceAvg > 4.5) return { prediction: 'tai', confidence: 60, algorithm: 'Xúc xắc cao' };
  if (diceAvg < 2.5) return { prediction: 'xiu', confidence: 60, algorithm: 'Xúc xắc thấp' };
  return { prediction: last.ket_qua === 'tai' ? 'xiu' : 'tai', confidence: 50, algorithm: 'Xu hướng Xúc Xắc' };
}

function algorithmFibonacciSequence(historyAsc) {
  const seq = historyAsc.map(i => i.ket_qua);
  let current = 1;
  for (let i=1; i<seq.length; i++) {
    if (seq[i] === seq[i-1]) current++;
    else current = 1;
  }
  const last = historyAsc[historyAsc.length-1];
  const fibs = [1,2,3,5,8];
  if (fibs.includes(current)) {
    return { prediction: last.ket_qua === 'tai' ? 'xiu' : 'tai', confidence: 65, algorithm: 'Fibonacci Break' };
  }
  return { prediction: last.ket_qua, confidence: 50, algorithm: 'Fibonacci Sequence' };
}

function algorithmRSIResult(historyAsc, period=14) {
  const len = historyAsc.length;
  if (len < period+1) return { prediction: historyAsc[len-1].ket_qua, confidence: 40, algorithm: `RSI Kết quả (${period})` };
  const changes = [];
  for (let i = len-period; i < len; i++) {
    changes.push(historyAsc[i].ket_qua === 'tai' ? 1 : -1);
  }
  let avgGain = 0, avgLoss = 0;
  changes.forEach(c => {
    if (c > 0) avgGain += c;
    else avgLoss += Math.abs(c);
  });
  avgGain /= period;
  avgLoss /= period;
  if (avgLoss === 0) return { prediction: 'tai', confidence: 80, algorithm: `RSI KQ (${period})` };
  const rs = avgGain / avgLoss;
  const rsi = 100 - (100/(1+rs));
  const prediction = rsi > 50 ? 'tai' : 'xiu';
  return { prediction, confidence: Math.min(80, Math.abs(rsi-50)+40), algorithm: `RSI KQ (${period})` };
}

// --- Thuật toán mới nâng cao ---
function algorithmMomentum(historyAsc, period = 5) {
  const len = historyAsc.length;
  if (len < period + 1) return { prediction: historyAsc[len-1].ket_qua, confidence: 40, algorithm: `Momentum (${period})` };
  const momentum = historyAsc[len-1].tong - historyAsc[len-period-1].tong;
  return { prediction: momentum > 0 ? 'tai' : 'xiu', confidence: Math.min(70, Math.abs(momentum)*5), algorithm: `Momentum (${period})` };
}

function algorithmROC(historyAsc, period = 5) {
  const len = historyAsc.length;
  if (len < period) return { prediction: historyAsc[len-1].ket_qua, confidence: 40, algorithm: `ROC (${period})` };
  const prev = historyAsc[len-period].tong;
  if (prev === 0) return { prediction: historyAsc[len-1].ket_qua, confidence: 40, algorithm: `ROC (${period})` };
  const roc = ((historyAsc[len-1].tong - prev) / prev) * 100;
  return { prediction: roc > 0 ? 'tai' : 'xiu', confidence: Math.min(65, Math.abs(roc)), algorithm: `ROC (${period})` };
}

function algorithmTSI(historyAsc, r = 5, s = 8) {
  const len = historyAsc.length;
  if (len < r + s) return { prediction: historyAsc[len-1].ket_qua, confidence: 40, algorithm: `TSI (${r},${s})` };
  const changes = [];
  for (let i = 1; i < len; i++) changes.push(historyAsc[i].tong - historyAsc[i-1].tong);
  const ema = (arr, period) => {
    const k = 2/(period+1);
    let result = [arr[0]];
    for (let i=1; i<arr.length; i++) result.push(arr[i]*k + result[i-1]*(1-k));
    return result;
  };
  const ema1 = ema(changes, r);
  const ema2 = ema(ema1, s);
  const lastTSI = ema2[ema2.length-1];
  return { prediction: lastTSI > 0 ? 'tai' : 'xiu', confidence: Math.min(70, Math.abs(lastTSI)*10), algorithm: `TSI (${r},${s})` };
}

function algorithmKeltner(historyAsc, period=10, multiplier=1.5) {
  const len = historyAsc.length;
  if (len < period) return { prediction: historyAsc[len-1].ket_qua, confidence: 40, algorithm: `Keltner (${period})` };
  const prices = historyAsc.slice(-period).map(i => i.tong);
  const ma = prices.reduce((a,b)=>a+b,0)/period;
  const tr = [];
  for (let i=1; i<prices.length; i++) tr.push(Math.abs(prices[i]-prices[i-1]));
  const atr = tr.reduce((a,b)=>a+b,0)/tr.length;
  const upper = ma + multiplier * atr;
  const lower = ma - multiplier * atr;
  const last = prices[prices.length-1];
  if (last > upper) return { prediction: 'xiu', confidence: 60, algorithm: `Keltner (${period})` };
  if (last < lower) return { prediction: 'tai', confidence: 60, algorithm: `Keltner (${period})` };
  return { prediction: last > ma ? 'tai' : 'xiu', confidence: 50, algorithm: `Keltner (${period})` };
}

function algorithmATR(historyAsc, period=7) {
  const len = historyAsc.length;
  if (len < period+1) return { prediction: historyAsc[len-1].ket_qua, confidence: 40, algorithm: `ATR (${period})` };
  const tr = [];
  for (let i=1; i<len; i++) tr.push(Math.abs(historyAsc[i].tong - historyAsc[i-1].tong));
  const atr = tr.slice(-period).reduce((a,b)=>a+b,0)/period;
  const lastChange = tr[tr.length-1];
  if (lastChange > atr * 1.5) return { prediction: 'xiu', confidence: 60, algorithm: `ATR (${period})` };
  if (lastChange < atr * 0.5) return { prediction: 'tai', confidence: 55, algorithm: `ATR (${period})` };
  return { prediction: historyAsc[len-1].ket_qua === 'tai' ? 'xiu' : 'tai', confidence: 45, algorithm: `ATR (${period})` };
}

function algorithmADX(historyAsc, period=7) {
  const len = historyAsc.length;
  if (len < period*2) return { prediction: historyAsc[len-1].ket_qua, confidence: 40, algorithm: `ADX (${period})` };
  const dmPlus = [], dmMinus = [], trArr = [];
  for (let i=1; i<len; i++) {
    const up = historyAsc[i].tong - historyAsc[i-1].tong;
    const down = historyAsc[i-1].tong - historyAsc[i].tong;
    dmPlus.push(up > down && up > 0 ? up : 0);
    dmMinus.push(down > up && down > 0 ? down : 0);
    trArr.push(Math.abs(historyAsc[i].tong - historyAsc[i-1].tong));
  }
  const sma = (arr) => arr.slice(-period).reduce((a,b)=>a+b,0)/period;
  const atr = sma(trArr);
  if (atr === 0) return { prediction: historyAsc[len-1].ket_qua, confidence: 40, algorithm: `ADX (${period})` };
  const diPlus = (sma(dmPlus) / atr) * 100;
  const diMinus = (sma(dmMinus) / atr) * 100;
  if (diPlus > diMinus) return { prediction: 'tai', confidence: 55, algorithm: `ADX (${period})` };
  return { prediction: 'xiu', confidence: 55, algorithm: `ADX (${period})` };
}

function algorithmParabolicSAR(historyAsc, acceleration=0.02, maxAccel=0.2) {
  const len = historyAsc.length;
  if (len < 5) return { prediction: historyAsc[len-1].ket_qua, confidence: 40, algorithm: 'Parabolic SAR' };
  let trend = historyAsc[0].tong < historyAsc[1].tong ? 'tai' : 'xiu';
  let sar = trend === 'tai' ? Math.min(...historyAsc.slice(0,2).map(i=>i.tong)) : Math.max(...historyAsc.slice(0,2).map(i=>i.tong));
  let ep = trend === 'tai' ? Math.max(...historyAsc.slice(0,2).map(i=>i.tong)) : Math.min(...historyAsc.slice(0,2).map(i=>i.tong));
  let af = acceleration;
  for (let i=2; i<len; i++) {
    const price = historyAsc[i].tong;
    sar = sar + af * (ep - sar);
    if ((trend === 'tai' && price < sar) || (trend === 'xiu' && price > sar)) {
      trend = trend === 'tai' ? 'xiu' : 'tai';
      sar = ep;
      af = acceleration;
      ep = price;
    } else {
      if (trend === 'tai' && price > ep) { ep = price; af = Math.min(af+acceleration, maxAccel); }
      else if (trend === 'xiu' && price < ep) { ep = price; af = Math.min(af+acceleration, maxAccel); }
    }
  }
  return { prediction: trend, confidence: 55, algorithm: 'Parabolic SAR' };
}

function algorithmEntropy(historyAsc, window=20) {
  const seq = historyAsc.slice(-window).map(i => i.ket_qua).join('');
  const freq = {};
  for (let c of seq) freq[c] = (freq[c] || 0) + 1;
  let entropy = 0;
  for (let k in freq) {
    const p = freq[k] / seq.length;
    entropy -= p * Math.log2(p);
  }
  const maxEntropy = Math.log2(2);
  const normalized = entropy / maxEntropy;
  if (normalized > 0.8) return { prediction: historyAsc[historyAsc.length-1].ket_qua === 'tai' ? 'xiu' : 'tai', confidence: 60, algorithm: 'Entropy cao' };
  return { prediction: historyAsc[historyAsc.length-1].ket_qua, confidence: 50, algorithm: 'Entropy thấp' };
}

function algorithmPoisson(historyAsc, period=15) {
  const slice = historyAsc.slice(-period);
  if (slice.length < period) return { prediction: historyAsc[historyAsc.length-1].ket_qua, confidence: 40, algorithm: `Poisson (${period})` };
  const mean = slice.reduce((s,i)=>s+i.tong,0)/slice.length;
  function poissonCDF(k, lambda) {
    let sum = 0, term = Math.exp(-lambda);
    for (let i=0; i<=k; i++) {
      sum += term;
      term *= lambda/(i+1);
    }
    return sum;
  }
  const probTai = 1 - poissonCDF(10, mean);
  const prediction = probTai > 0.5 ? 'tai' : 'xiu';
  return { prediction, confidence: Math.min(70, Math.abs(probTai-0.5)*200), algorithm: `Poisson (${period})` };
}

function algorithmLinearRegression(historyAsc, period=12) {
  const len = historyAsc.length;
  if (len < period) return { prediction: historyAsc[len-1].ket_qua, confidence: 40, algorithm: `Linear Reg (${period})` };
  const x = [], y = [];
  for (let i=len-period; i<len; i++) { x.push(i - (len-period)); y.push(historyAsc[i].tong); }
  const n = x.length;
  const sumX = x.reduce((a,b)=>a+b,0), sumY = y.reduce((a,b)=>a+b,0);
  const sumXY = x.reduce((s,xi,i)=>s+xi*y[i],0), sumX2 = x.reduce((s,xi)=>s+xi*xi,0);
  const slope = (n*sumXY - sumX*sumY) / (n*sumX2 - sumX*sumX);
  return { prediction: slope > 0 ? 'tai' : 'xiu', confidence: Math.min(65, Math.abs(slope)*10), algorithm: `Linear Reg (${period})` };
}

function algorithmAR1(historyAsc, period=10) {
  const len = historyAsc.length;
  if (len < period+2) return { prediction: historyAsc[len-1].ket_qua, confidence: 40, algorithm: `AR(1) (${period})` };
  const y = historyAsc.slice(-period-1).map(i => i.tong);
  let sumYt=0, sumYt1=0, sumYtSq=0, sumYt1Sq=0, sumYtYt1=0;
  for (let t=1; t<y.length; t++) {
    sumYt += y[t]; sumYt1 += y[t-1];
    sumYtSq += y[t]*y[t]; sumYt1Sq += y[t-1]*y[t-1];
    sumYtYt1 += y[t]*y[t-1];
  }
  const n = y.length-1;
  const phi = (n*sumYtYt1 - sumYt*sumYt1) / (n*sumYt1Sq - sumYt1*sumYt1);
  const forecast = phi * y[y.length-1] + (1-phi)*(sumYt/n);
  return { prediction: forecast > 10.5 ? 'tai' : 'xiu', confidence: 55, algorithm: `AR(1) (${period})` };
}

function algorithmFractal(historyAsc, kmax=5) {
  const len = historyAsc.length;
  if (len < kmax*3) return { prediction: historyAsc[len-1].ket_qua, confidence: 40, algorithm: 'Fractal' };
  const x = historyAsc.map(i => i.tong);
  const L = (k) => {
    let sum = 0;
    for (let m=0; m<k; m++) {
      let lenSeq = 0, cnt = 0;
      for (let i=m; i+k < x.length; i+=k) {
        lenSeq += Math.abs(x[i+k] - x[i]);
        cnt++;
      }
      if (cnt > 0) sum += (lenSeq / cnt) * ((x.length-1)/(cnt*k));
    }
    return sum/k;
  };
  const lengths = [];
  for (let k=1; k<=kmax; k++) lengths.push(Math.log(L(k)));
  const logK = [1,2,3,4,5].map(Math.log);
  const n = lengths.length;
  const sumX=logK.reduce((a,b)=>a+b,0), sumY=lengths.reduce((a,b)=>a+b,0);
  const slope = (n*logK.reduce((s,x,i)=>s+x*lengths[i],0) - sumX*sumY) / (n*logK.reduce((s,x)=>s+x*x,0)-sumX*sumX);
  if (slope < 1.5) return { prediction: 'tai', confidence: 60, algorithm: 'Fractal trend' };
  return { prediction: 'xiu', confidence: 50, algorithm: 'Fractal range' };
}

function algorithmDiceFrequency1(historyAsc, period=20) {
  const slice = historyAsc.slice(-period);
  const freq = new Array(7).fill(0);
  slice.forEach(i => freq[i.xuc_xac_1]++);
  const maxIdx = freq.indexOf(Math.max(...freq.slice(1)));
  return { prediction: maxIdx >= 4 ? 'tai' : 'xiu', confidence: 55, algorithm: 'Tần suất Xúc xắc 1' };
}

function algorithmAvg3Gap(historyAsc) {
  const len = historyAsc.length;
  if (len < 4) return { prediction: historyAsc[len-1].ket_qua, confidence: 40, algorithm: 'Avg3 Gap' };
  const avg3 = (historyAsc[len-1].tong + historyAsc[len-2].tong + historyAsc[len-3].tong)/3;
  const prev = historyAsc[len-4].tong;
  return { prediction: avg3 > prev ? 'tai' : 'xiu', confidence: Math.min(65, Math.abs(avg3-prev)*5), algorithm: 'Avg3 Gap' };
}

function algorithmPivot(historyAsc, period=5) {
  const slice = historyAsc.slice(-period);
  const high = Math.max(...slice.map(i=>i.tong));
  const low = Math.min(...slice.map(i=>i.tong));
  const pivot = (high+low+slice[slice.length-1].tong)/3;
  const last = slice[slice.length-1].tong;
  if (last > pivot*1.05) return { prediction: 'tai', confidence: 55, algorithm: 'Pivot break up' };
  if (last < pivot*0.95) return { prediction: 'xiu', confidence: 55, algorithm: 'Pivot break down' };
  return { prediction: last > pivot ? 'tai' : 'xiu', confidence: 45, algorithm: 'Pivot range' };
}

function algorithmElliott(historyAsc) {
  const seq = historyAsc.map(i => i.ket_qua);
  let waves = 0, current = seq[0], cnt = 0;
  for (let k of seq) {
    if (k === current) cnt++;
    else { if (cnt>=3) waves++; current = k; cnt=1; }
  }
  if (waves >= 5) return { prediction: current === 'tai' ? 'xiu' : 'tai', confidence: 60, algorithm: 'Elliott Wave' };
  return { prediction: current, confidence: 50, algorithm: 'Elliott' };
}

function algorithmHullMA(historyAsc, period=10) {
  const len = historyAsc.length;
  if (len < period) return { prediction: historyAsc[len-1].ket_qua, confidence: 40, algorithm: `Hull MA (${period})` };
  const prices = historyAsc.map(i => i.tong);
  const wma = (src, p) => {
    let sum = 0, weightSum = 0;
    for (let i=0; i<src.length; i++) {
      const w = i+1;
      sum += src[i]*w;
      weightSum += w;
    }
    return sum/weightSum;
  };
  const half = Math.floor(period/2);
  const sqrtP = Math.floor(Math.sqrt(period));
  const recentPrices = prices.slice(-period);
  const wma1 = wma(recentPrices.slice(-half), half);
  const wma2 = wma(recentPrices, period);
  const hull = wma(recentPrices.slice(-sqrtP).map((_, i) => 2*wma1 - wma2), sqrtP);
  return { prediction: hull > prices[prices.length-1] ? 'tai' : 'xiu', confidence: 55, algorithm: `Hull MA (${period})` };
}

function algorithmStdDice2(historyAsc) {
  const slice = historyAsc.slice(-12);
  const vals = slice.map(i => i.xuc_xac_2);
  const mean = vals.reduce((a,b)=>a+b,0)/vals.length;
  const std = Math.sqrt(vals.reduce((s,v)=>s+Math.pow(v-mean,2),0)/vals.length);
  if (std > 1.8) return { prediction: 'tai', confidence: 55, algorithm: 'Std Dice 2 high' };
  return { prediction: 'xiu', confidence: 55, algorithm: 'Std Dice 2 low' };
}

function algorithmCorrDice13(historyAsc) {
  const slice = historyAsc.slice(-15);
  const x1 = slice.map(i=>i.xuc_xac_1), x3 = slice.map(i=>i.xuc_xac_3);
  const sumX1=x1.reduce((a,b)=>a+b,0), sumX3=x3.reduce((a,b)=>a+b,0);
  const n = x1.length;
  const sumXY = x1.reduce((s,v,i)=>s+v*x3[i],0);
  const r = (n*sumXY - sumX1*sumX3) / (Math.sqrt(n*x1.reduce((s,v)=>s+v*v,0)-sumX1*sumX1) * Math.sqrt(n*x3.reduce((s,v)=>s+v*v,0)-sumX3*sumX3));
  if (r > 0.3) return { prediction: 'tai', confidence: 55, algorithm: 'Corr Dice 1-3 pos' };
  if (r < -0.3) return { prediction: 'xiu', confidence: 55, algorithm: 'Corr Dice 1-3 neg' };
  return { prediction: historyAsc[historyAsc.length-1].ket_qua === 'tai' ? 'xiu' : 'tai', confidence: 45, algorithm: 'Corr Dice 1-3' };
}

function algorithmEvenOddDice3(historyAsc) {
  const last = historyAsc[historyAsc.length-1];
  const cntEven = [last.xuc_xac_1, last.xuc_xac_2, last.xuc_xac_3].filter(d=>d%2===0).length;
  if (cntEven === 3) return { prediction: 'xiu', confidence: 60, algorithm: 'All Even' };
  if (cntEven === 0) return { prediction: 'tai', confidence: 60, algorithm: 'All Odd' };
  return { prediction: cntEven >= 2 ? 'tai' : 'xiu', confidence: 50, algorithm: 'EvenOdd Mix' };
}

function algorithmCycle2(historyAsc) {
  const len = historyAsc.length;
  if (len < 6) return { prediction: historyAsc[len-1].ket_qua, confidence: 40, algorithm: 'Cycle 2' };
  const pattern = historyAsc[len-2].ket_qua + historyAsc[len-1].ket_qua;
  let count = 0, lastIdx = -1;
  for (let i=0; i<len-1; i++) {
    if (historyAsc[i].ket_qua + historyAsc[i+1].ket_qua === pattern) {
      count++;
      lastIdx = i;
    }
  }
  if (count >= 3 && lastIdx+2 < len) {
    const next = historyAsc[lastIdx+2].ket_qua;
    return { prediction: next, confidence: 65, algorithm: 'Cycle 2 lặp' };
  }
  return { prediction: pattern[1] === 't' ? 'xiu' : 'tai', confidence: 50, algorithm: 'Cycle 2' };
}

function algorithmRange(historyAsc, period=8) {
  const slice = historyAsc.slice(-period);
  const range = Math.max(...slice.map(i=>i.tong)) - Math.min(...slice.map(i=>i.tong));
  if (range > 10) return { prediction: 'xiu', confidence: 55, algorithm: 'Range rộng' };
  return { prediction: 'tai', confidence: 55, algorithm: 'Range hẹp' };
}

function algorithmHarami(historyAsc) {
  const len = historyAsc.length;
  if (len < 2) return { prediction: historyAsc[len-1].ket_qua, confidence: 40, algorithm: 'Harami' };
  const prev = historyAsc[len-2], last = historyAsc[len-1];
  if (prev.ket_qua === 'tai' && prev.tong > 14 && last.ket_qua === 'xiu' && last.tong < 7) return { prediction: 'xiu', confidence: 65, algorithm: 'Bearish Harami' };
  if (prev.ket_qua === 'xiu' && prev.tong < 6 && last.ket_qua === 'tai' && last.tong > 14) return { prediction: 'tai', confidence: 65, algorithm: 'Bullish Harami' };
  return { prediction: last.ket_qua, confidence: 50, algorithm: 'Harami' };
}

function algorithmTwoSum(historyAsc) {
  const len = historyAsc.length;
  if (len < 3) return { prediction: historyAsc[len-1].ket_qua, confidence: 40, algorithm: 'Two Sum' };
  const sumLast = historyAsc[len-1].tong + historyAsc[len-2].tong;
  if (sumLast > 22) return { prediction: 'xiu', confidence: 60, algorithm: 'Two Sum high' };
  if (sumLast < 9) return { prediction: 'tai', confidence: 60, algorithm: 'Two Sum low' };
  return { prediction: sumLast > 14 ? 'tai' : 'xiu', confidence: 50, algorithm: 'Two Sum' };
}

function algorithmIchimoku(historyAsc, tenkan=9, kijun=26) {
  const len = historyAsc.length;
  if (len < kijun) return { prediction: historyAsc[len-1].ket_qua, confidence: 40, algorithm: 'Ichimoku' };
  const highT = historyAsc.slice(-tenkan).reduce((a,b)=>Math.max(a,b.tong),0);
  const lowT = historyAsc.slice(-tenkan).reduce((a,b)=>Math.min(a,b.tong),Infinity);
  const tenkanSen = (highT+lowT)/2;
  const highK = historyAsc.slice(-kijun).reduce((a,b)=>Math.max(a,b.tong),0);
  const lowK = historyAsc.slice(-kijun).reduce((a,b)=>Math.min(a,b.tong),Infinity);
  const kijunSen = (highK+lowK)/2;
  const last = historyAsc[len-1].tong;
  if (last > Math.max(tenkanSen, kijunSen)) return { prediction: 'tai', confidence: 55, algorithm: 'Ichimoku Cloud' };
  if (last < Math.min(tenkanSen, kijunSen)) return { prediction: 'xiu', confidence: 55, algorithm: 'Ichimoku Cloud' };
  return { prediction: last > (tenkanSen+kijunSen)/2 ? 'tai' : 'xiu', confidence: 50, algorithm: 'Ichimoku' };
}

function algorithmTenEleven(historyAsc) {
  const last = historyAsc[historyAsc.length-1];
  if (last.tong === 10 || last.tong === 11) {
    return { prediction: historyAsc.length > 1 ? historyAsc[historyAsc.length-2].ket_qua : 'tai', confidence: 60, algorithm: '10/11 đặc biệt' };
  }
  return { prediction: last.ket_qua, confidence: 50, algorithm: '10/11' };
}

function algorithmAroon(historyAsc, period=14) {
  const len = historyAsc.length;
  if (len < period) return { prediction: historyAsc[len-1].ket_qua, confidence: 40, algorithm: `Aroon (${period})` };
  const slice = historyAsc.slice(-period);
  const highIdx = slice.reduce((iMax, x, i, arr) => x.tong > arr[iMax].tong ? i : iMax, 0);
  const lowIdx = slice.reduce((iMin, x, i, arr) => x.tong < arr[iMin].tong ? i : iMin, 0);
  const aroonUp = ((period-1 - highIdx) / (period-1)) * 100;
  const aroonDown = ((period-1 - lowIdx) / (period-1)) * 100;
  if (aroonUp > 70 && aroonDown < 30) return { prediction: 'tai', confidence: 55, algorithm: 'Aroon Up' };
  if (aroonDown > 70 && aroonUp < 30) return { prediction: 'xiu', confidence: 55, algorithm: 'Aroon Down' };
  return { prediction: historyAsc[len-1].ket_qua, confidence: 45, algorithm: 'Aroon' };
}

function algorithmDeviation3(historyAsc) {
  const len = historyAsc.length;
  if (len < 4) return { prediction: historyAsc[len-1].ket_qua, confidence: 40, algorithm: 'Deviation 3' };
  const avg3 = (historyAsc[len-2].tong + historyAsc[len-3].tong + historyAsc[len-4].tong)/3;
  const dev = historyAsc[len-1].tong - avg3;
  if (dev > 3) return { prediction: 'xiu', confidence: 60, algorithm: 'Deviation > 3' };
  if (dev < -3) return { prediction: 'tai', confidence: 60, algorithm: 'Deviation < -3' };
  return { prediction: dev > 0 ? 'tai' : 'xiu', confidence: 50, algorithm: 'Deviation 3' };
}

function algorithmTriple(historyAsc) {
  const last = historyAsc[historyAsc.length-1];
  if (last.xuc_xac_1 === last.xuc_xac_2 && last.xuc_xac_2 === last.xuc_xac_3) {
    return { prediction: last.ket_qua === 'tai' ? 'xiu' : 'tai', confidence: 70, algorithm: 'Triple (Bão)' };
  }
  return { prediction: last.ket_qua, confidence: 50, algorithm: 'Triple' };
}

function algorithmDice1Change(historyAsc) {
  const len = historyAsc.length;
  if (len < 3) return { prediction: historyAsc[len-1].ket_qua, confidence: 40, algorithm: 'Dice1 Change' };
  const diff = historyAsc[len-1].xuc_xac_1 - historyAsc[len-2].xuc_xac_1;
  if (diff > 2) return { prediction: 'tai', confidence: 60, algorithm: 'Dice1 tăng mạnh' };
  if (diff < -2) return { prediction: 'xiu', confidence: 60, algorithm: 'Dice1 giảm mạnh' };
  return { prediction: diff > 0 ? 'tai' : 'xiu', confidence: 50, algorithm: 'Dice1 Change' };
}

function algorithmDEMA(historyAsc, period=10) {
  const len = historyAsc.length;
  if (len < period) return { prediction: historyAsc[len-1].ket_qua, confidence: 40, algorithm: `DEMA (${period})` };
  const prices = historyAsc.map(i => i.tong);
  const ema = (data, p) => {
    const k = 2/(p+1);
    let e = data[0];
    for (let i=1; i<data.length; i++) e = data[i]*k + e*(1-k);
    return e;
  };
  const ema1 = ema(prices.slice(-period), period);
  const ema2 = ema([...Array(period).fill(ema1)], period); // EMA của EMA, xấp xỉ
  const dema = 2*ema1 - ema2;
  return { prediction: dema > prices[prices.length-1] ? 'tai' : 'xiu', confidence: 55, algorithm: `DEMA (${period})` };
}

function algorithmDoubleTopBottom(historyAsc) {
  const slice = historyAsc.slice(-10);
  const tops = [], bottoms = [];
  for (let i=1; i<slice.length-1; i++) {
    if (slice[i].tong > slice[i-1].tong && slice[i].tong > slice[i+1].tong) tops.push(slice[i].tong);
    if (slice[i].tong < slice[i-1].tong && slice[i].tong < slice[i+1].tong) bottoms.push(slice[i].tong);
  }
  const last = slice[slice.length-1].tong;
  if (tops.length >= 2 && Math.abs(tops[tops.length-1] - tops[tops.length-2]) < 2) return { prediction: 'xiu', confidence: 65, algorithm: 'Double Top' };
  if (bottoms.length >= 2 && Math.abs(bottoms[bottoms.length-1] - bottoms[bottoms.length-2]) < 2) return { prediction: 'tai', confidence: 65, algorithm: 'Double Bottom' };
  return { prediction: historyAsc[historyAsc.length-1].ket_qua === 'tai' ? 'xiu' : 'tai', confidence: 50, algorithm: 'Double Pattern' };
}

function algorithmChiSquareDice(historyAsc) {
  const slice = historyAsc.slice(-18);
  const freq = Array(7).fill(0);
  slice.forEach(i => { freq[i.xuc_xac_1]++; freq[i.xuc_xac_2]++; freq[i.xuc_xac_3]++; });
  const expected = (slice.length*3)/6;
  let chi2 = 0;
  for (let i=1; i<=6; i++) chi2 += Math.pow(freq[i]-expected,2)/expected;
  if (chi2 > 11.07) return { prediction: 'tai', confidence: 55, algorithm: 'Chi-square cao' };
  return { prediction: 'xiu', confidence: 55, algorithm: 'Chi-square thấp' };
}

function algorithmRepeatSum(historyAsc) {
  const last = historyAsc[historyAsc.length-1].tong;
  const count = historyAsc.slice(-20).filter(i => i.tong === last).length;
  if (count >= 3) return { prediction: last > 10 ? 'xiu' : 'tai', confidence: 60, algorithm: 'Repeat Sum nhiều' };
  return { prediction: last > 10 ? 'tai' : 'xiu', confidence: 50, algorithm: 'Repeat Sum' };
}

function algorithmDiceDiff12(historyAsc) {
  const diffs = historyAsc.slice(-12).map(i => i.xuc_xac_1 - i.xuc_xac_2);
  const avgDiff = diffs.reduce((a,b)=>a+b,0)/diffs.length;
  if (avgDiff > 0.5) return { prediction: 'tai', confidence: 55, algorithm: 'Diff 1-2 dương' };
  if (avgDiff < -0.5) return { prediction: 'xiu', confidence: 55, algorithm: 'Diff 1-2 âm' };
  return { prediction: historyAsc[historyAsc.length-1].ket_qua === 'tai' ? 'xiu' : 'tai', confidence: 45, algorithm: 'Diff 1-2' };
}

function algorithmFibExtension(historyAsc) {
  const slice = historyAsc.slice(-8);
  const high = Math.max(...slice.map(i=>i.tong));
  const low = Math.min(...slice.map(i=>i.tong));
  const diff = high - low;
  const levels = [0.618, 1.0, 1.618].map(r => low + diff*r);
  const last = historyAsc[historyAsc.length-1].tong;
  if (last > levels[1]) return { prediction: 'tai', confidence: 60, algorithm: 'Fib Extension' };
  if (last < levels[0]) return { prediction: 'xiu', confidence: 60, algorithm: 'Fib Extension' };
  return { prediction: last > (levels[0]+levels[1])/2 ? 'tai' : 'xiu', confidence: 50, algorithm: 'Fib Extension' };
}

function algorithmRatioChange(historyAsc) {
  const recent = historyAsc.slice(-5);
  const prev = historyAsc.slice(-10, -5);
  const ratioRecent = recent.filter(i=>i.ket_qua==='tai').length/5;
  const ratioPrev = prev.filter(i=>i.ket_qua==='tai').length/5;
  if (ratioRecent > 0.7 && ratioPrev < 0.5) return { prediction: 'xiu', confidence: 60, algorithm: 'Ratio change' };
  if (ratioRecent < 0.3 && ratioPrev > 0.5) return { prediction: 'tai', confidence: 60, algorithm: 'Ratio change' };
  return { prediction: ratioRecent > 0.5 ? 'tai' : 'xiu', confidence: 50, algorithm: 'Ratio' };
}

function algorithmDoji(historyAsc) {
  const last = historyAsc[historyAsc.length-1];
  if (last.tong >= 10 && last.tong <= 11) return { prediction: last.ket_qua === 'tai' ? 'xiu' : 'tai', confidence: 55, algorithm: 'Doji' };
  return { prediction: last.ket_qua, confidence: 50, algorithm: 'Doji' };
}

function algorithmBB_RSI(historyAsc) {
  const bb = algorithmBollingerBands(historyAsc, 14, 2);
  const rsi = algorithmRSITong(historyAsc, 14);
  if (bb.prediction === rsi.prediction) return { prediction: bb.prediction, confidence: Math.max(bb.confidence, rsi.confidence), algorithm: 'BB+RSI agree' };
  return { prediction: rsi.prediction, confidence: rsi.confidence, algorithm: 'BB+RSI disagree' };
}

// ==================== DANH SÁCH TẤT CẢ THUẬT TOÁN ====================
function buildAlgorithmList() {
  return [
    algorithmInvertLast, algorithmFollowStreak,
    (asc) => algorithmBreakLong(asc, 3), (asc) => algorithmBreakLong(asc, 4),
    makeFrequencyBalance(5), makeFrequencyBalance(7), makeFrequencyBalance(10),
    makeFrequencyBalance(12), makeFrequencyBalance(15), makeFrequencyBalance(20),
    (asc) => algorithmTotalTrend(asc, 3), (asc) => algorithmTotalTrend(asc, 5), (asc) => algorithmTotalTrend(asc, 7),
    algorithmEvenOddTrend,
    (asc) => algorithmMirrorPattern(asc, 3), (asc) => algorithmMirrorPattern(asc, 4), (asc) => algorithmMirrorPattern(asc, 5),
    algorithmStochasticOscillator, algorithmMartingaleReverse,
    algorithmMarkovChain1, algorithmMarkovChain2,
    (asc) => algorithmRSITong(asc, 7), (asc) => algorithmRSITong(asc, 14), (asc) => algorithmRSITong(asc, 21),
    (asc) => algorithmBollingerBands(asc, 10, 2), (asc) => algorithmBollingerBands(asc, 20, 2),
    algorithmFibonacciRetracement, algorithmCandlestickPattern,
    (asc) => algorithmEMACross(asc, 5, 10), (asc) => algorithmEMACross(asc, 7, 14), (asc) => algorithmEMACross(asc, 3, 7),
    (asc) => algorithmMACD(asc, 6, 13, 5), (asc) => algorithmMACD(asc, 5, 10, 4), (asc) => algorithmMACD(asc, 8, 17, 7),
    (asc) => algorithmBinomialBalance(asc, 15), (asc) => algorithmBinomialBalance(asc, 25),
    algorithmDiceEvenOdd, algorithmCandlestick3,
    (asc) => algorithmMovingAverageThreshold(asc, 8), (asc) => algorithmMovingAverageThreshold(asc, 12),
    (asc) => algorithmStdDev(asc, 10), (asc) => algorithmStdDev(asc, 15),
    algorithmDiceComponentTrend, algorithmFibonacciSequence,
    (asc) => algorithmRSIResult(asc, 10), (asc) => algorithmRSIResult(asc, 20),
    (asc) => { const len = asc.length; if (len < 2) return { prediction: asc[len-1].ket_qua, confidence: 40, algorithm: 'TB 2 phiên' }; const avg = (asc[len-1].tong + asc[len-2].tong)/2; return { prediction: avg > 10.5 ? 'tai' : 'xiu', confidence: Math.abs(avg-10.5)*10, algorithm: 'TB 2 phiên' }; },
    (asc) => { const len = asc.length; if (len < 6) return { prediction: asc[len-1].ket_qua, confidence: 40, algorithm: 'So sánh 3-3' }; const sumRecent = asc.slice(-3).reduce((s,i)=>s+i.tong,0); const sumPrev = asc.slice(-6,-3).reduce((s,i)=>s+i.tong,0); return { prediction: sumRecent > sumPrev ? 'tai' : 'xiu', confidence: Math.min(70, Math.abs(sumRecent-sumPrev)/2), algorithm: 'So sánh 3-3' }; },
    (asc) => { const last10 = asc.slice(-10); let count = 0; last10.forEach(i => { if (i.xuc_xac_1 > 3) count++; }); const pred = count > 5 ? 'tai' : 'xiu'; return { prediction: pred, confidence: 50 + Math.abs(count-5)*5, algorithm: 'Xúc xắc 1 > 3' }; },
    algorithmMomentum, (asc) => algorithmMomentum(asc, 3), (asc) => algorithmMomentum(asc, 7),
    algorithmROC, (asc) => algorithmROC(asc, 3), (asc) => algorithmROC(asc, 10),
    algorithmTSI, (asc) => algorithmTSI(asc, 4, 7),
    algorithmKeltner, (asc) => algorithmKeltner(asc, 14, 1.8),
    algorithmATR, (asc) => algorithmATR(asc, 5),
    algorithmADX, (asc) => algorithmADX(asc, 5),
    algorithmParabolicSAR, (asc) => algorithmParabolicSAR(asc, 0.03, 0.25),
    algorithmEntropy, (asc) => algorithmEntropy(asc, 15),
    algorithmPoisson, (asc) => algorithmPoisson(asc, 20),
    algorithmLinearRegression, (asc) => algorithmLinearRegression(asc, 8),
    algorithmAR1,
    algorithmFractal,
    algorithmDiceFrequency1, (asc) => algorithmDiceFrequency1(asc, 12),
    algorithmAvg3Gap,
    algorithmPivot, (asc) => algorithmPivot(asc, 7),
    algorithmElliott,
    algorithmHullMA, (asc) => algorithmHullMA(asc, 8), (asc) => algorithmHullMA(asc, 14),
    algorithmStdDice2,
    algorithmCorrDice13,
    algorithmEvenOddDice3,
    algorithmCycle2,
    algorithmRange, (asc) => algorithmRange(asc, 12),
    algorithmHarami,
    algorithmTwoSum,
    algorithmIchimoku, (asc) => algorithmIchimoku(asc, 7, 22),
    algorithmTenEleven,
    algorithmAroon, (asc) => algorithmAroon(asc, 10),
    algorithmDeviation3,
    algorithmTriple,
    algorithmDice1Change,
    algorithmDEMA, (asc) => algorithmDEMA(asc, 8),
    algorithmDoubleTopBottom,
    algorithmChiSquareDice,
    algorithmRepeatSum,
    algorithmDiceDiff12,
    algorithmFibExtension,
    algorithmRatioChange,
    algorithmDoji,
    algorithmBB_RSI
  ];
}

// ==================== BRAIN VIP (TRỌNG SỐ) ====================
function brainVIP(historyAsc) {
  const algorithms = buildAlgorithmList();
  const results = algorithms.map(fn => fn(historyAsc));
  const weightedVotes = { tai: 0, xiu: 0 };
  let totalWeight = 0;
  results.forEach(r => {
    const w = r.confidence / 100;
    weightedVotes[r.prediction] += w;
    totalWeight += w;
  });
  const latest = historyAsc[historyAsc.length - 1];
  let topPrediction, topConfidence;
  if (weightedVotes.tai > weightedVotes.xiu) {
    topPrediction = 'tai';
    topConfidence = (weightedVotes.tai / totalWeight) * 100;
  } else if (weightedVotes.xiu > weightedVotes.tai) {
    topPrediction = 'xiu';
    topConfidence = (weightedVotes.xiu / totalWeight) * 100;
  } else {
    topPrediction = latest.ket_qua === 'tai' ? 'xiu' : 'tai';
    topConfidence = 50;
  }
  return {
    prediction: topPrediction,
    confidence: +topConfidence.toFixed(2),
    algorithmsUsed: results.map(r => ({ name: r.algorithm, predict: r.prediction, conf: r.confidence })),
    totalAlgorithms: results.length
  };
}

// ==================== DỰ ĐOÁN & LƯU TRỮ ====================
function predictAndSave(historyList, game) {
  const sortedAsc = [...historyList].sort((a, b) => a.phien - b.phien);
  const latest = historyList[0];
  const predictedPhien = latest.phien + 1;
  const brain = brainVIP(sortedAsc);
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
    total_algorithms: buildAlgorithmList().length,
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
  console.log(`✅ Server SIÊU SIÊU SIÊU VIP chạy trên cổng ${PORT}`);
  console.log(`Tổng thuật toán: ${buildAlgorithmList().length}`);
});