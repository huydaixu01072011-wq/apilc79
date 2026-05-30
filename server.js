const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== CONFIG ====================
const API_URL_HU = 'https://wtx.tele68.com/v1/tx/sessions';
const API_URL_MD5 = 'https://wtxmd52.tele68.com/v1/txmd5/sessions';
const ADMIN_NAME = 'HuyDaiXuVN';

// ==================== IN-MEMORY PREDICTION STORE ====================
const predictions = [];
let predictionIdCounter = 0;
const MAX_PREDICTIONS = 500;

// ==================== UTILS ====================
function formatTime(date) {
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function transformData(list) {
  const sorted = list.sort((a, b) => b.id - a.id);
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

async function fetchHistory(apiUrl) {
  try {
    const response = await axios.get(apiUrl, { timeout: 10000 });
    if (!response.data || !Array.isArray(response.data.list)) {
      throw new Error('Invalid API response structure');
    }
    return transformData(response.data.list);
  } catch (error) {
    console.error(`Fetch error from ${apiUrl}:`, error.message);
    throw error;
  }
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
          console.log(`[CHECK] Phiên ${pred.predictedPhien} (${game}): dự đoán ${pred.prediction}, thực tế ${pred.actualKetQua} -> ${pred.status}`);
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

// ==================== THUẬT TOÁN (ĐẦY ĐỦ, KHÔNG RANDOM) ====================
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
  if (len < 2) return { prediction: historyAsc[len - 1].ket_qua, confidence: 50, algorithm: 'Theo Cầu (không đủ dữ liệu)' };
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

// THUẬT TOÁN MỚI SIÊU VIP (không tự học, chỉ phân tích thống kê)
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
  let maxStreak = 1, current = 1;
  for (let i=1; i<seq.length; i++) {
    if (seq[i] === seq[i-1]) current++;
    else { if (current>maxStreak) maxStreak = current; current = 1; }
  }
  if (current>maxStreak) maxStreak = current;
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

// Tạo danh sách TẤT CẢ THUẬT TOÁN
function buildAlgorithmList() {
  return [
    algorithmInvertLast,
    algorithmFollowStreak,
    (asc) => algorithmBreakLong(asc, 3),
    (asc) => algorithmBreakLong(asc, 4),
    makeFrequencyBalance(5),
    makeFrequencyBalance(7),
    makeFrequencyBalance(10),
    makeFrequencyBalance(12),
    makeFrequencyBalance(15),
    makeFrequencyBalance(20),
    (asc) => algorithmTotalTrend(asc, 3),
    (asc) => algorithmTotalTrend(asc, 5),
    (asc) => algorithmTotalTrend(asc, 7),
    algorithmEvenOddTrend,
    (asc) => algorithmMirrorPattern(asc, 3),
    (asc) => algorithmMirrorPattern(asc, 4),
    (asc) => algorithmMirrorPattern(asc, 5),
    algorithmStochasticOscillator,
    algorithmMartingaleReverse,
    algorithmMarkovChain1,
    algorithmMarkovChain2,
    (asc) => algorithmRSITong(asc, 7),
    (asc) => algorithmRSITong(asc, 14),
    (asc) => algorithmRSITong(asc, 21),
    (asc) => algorithmBollingerBands(asc, 10, 2),
    (asc) => algorithmBollingerBands(asc, 20, 2),
    algorithmFibonacciRetracement,
    algorithmCandlestickPattern,
    (asc) => algorithmEMACross(asc, 5, 10),
    (asc) => algorithmEMACross(asc, 7, 14),
    (asc) => algorithmEMACross(asc, 3, 7),
    (asc) => algorithmMACD(asc, 6, 13, 5),
    (asc) => algorithmMACD(asc, 5, 10, 4),
    (asc) => algorithmMACD(asc, 8, 17, 7),
    (asc) => algorithmBinomialBalance(asc, 15),
    (asc) => algorithmBinomialBalance(asc, 25),
    algorithmDiceEvenOdd,
    algorithmCandlestick3,
    (asc) => algorithmMovingAverageThreshold(asc, 8),
    (asc) => algorithmMovingAverageThreshold(asc, 12),
    (asc) => algorithmStdDev(asc, 10),
    (asc) => algorithmStdDev(asc, 15),
    algorithmDiceComponentTrend,
    algorithmFibonacciSequence,
    (asc) => algorithmRSIResult(asc, 10),
    (asc) => algorithmRSIResult(asc, 20),
    (asc) => {
      const len = asc.length;
      if (len < 2) return { prediction: asc[len-1].ket_qua, confidence: 40, algorithm: 'TB 2 phiên' };
      const avg = (asc[len-1].tong + asc[len-2].tong)/2;
      return { prediction: avg > 10.5 ? 'tai' : 'xiu', confidence: Math.abs(avg-10.5)*10, algorithm: 'TB 2 phiên' };
    },
    (asc) => {
      const len = asc.length;
      if (len < 6) return { prediction: asc[len-1].ket_qua, confidence: 40, algorithm: 'So sánh 3-3' };
      const sumRecent = asc.slice(-3).reduce((s,i)=>s+i.tong,0);
      const sumPrev = asc.slice(-6,-3).reduce((s,i)=>s+i.tong,0);
      return { prediction: sumRecent > sumPrev ? 'tai' : 'xiu', confidence: Math.min(70, Math.abs(sumRecent-sumPrev)/2), algorithm: 'So sánh 3-3' };
    },
    (asc) => {
      const last10 = asc.slice(-10);
      let count = 0;
      last10.forEach(i => { if (i.xuc_xac_1 > 3) count++; });
      const pred = count > 5 ? 'tai' : 'xiu';
      return { prediction: pred, confidence: 50 + Math.abs(count-5)*5, algorithm: 'Xúc xắc 1 > 3' };
    }
  ];
}

// ==================== BRAIN VIP (TỔNG HỢP TẤT CẢ THUẬT TOÁN) ====================
function brainVIP(historyAsc) {
  const algorithms = buildAlgorithmList();
  const results = algorithms.map(algoFn => algoFn(historyAsc));
  const votes = { tai: 0, xiu: 0 };
  results.forEach(r => votes[r.prediction]++);
  const totalVotes = votes.tai + votes.xiu;
  const latest = historyAsc[historyAsc.length - 1];
  const topPrediction = votes.tai > votes.xiu ? 'tai' : (votes.xiu > votes.tai ? 'xiu' : (latest.ket_qua === 'tai' ? 'xiu' : 'tai'));
  const topConfidence = (votes[topPrediction] / totalVotes) * 100;
  return {
    prediction: topPrediction,
    confidence: +topConfidence.toFixed(2),
    algorithmsUsed: results.map(r => ({ name: r.algorithm, predict: r.prediction, conf: r.confidence }))
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
    game: game,
    predictedPhien: predictedPhien,
    prediction: brain.prediction,
    confidence: brain.confidence,
    algorithmsUsed: brain.algorithmsUsed,
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
    pattern: pattern,
    du_doan: brain.prediction,
    do_tin_cay: brain.confidence + '%',
    admin: ADMIN_NAME,
    update: formatTime(new Date()),
    thuat_toan_su_dung: brain.algorithmsUsed,
    prediction_id: newPred.id
  };
}

function sendCompactJSON(res, data) {
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(data));
}

// ==================== ENDPOINTS ====================
app.get('/api/history/:game', async (req, res) => {
  const game = req.params.game === 'lc79' ? 'lc79' : 'md5';
  const apiUrl = game === 'lc79' ? API_URL_HU : API_URL_MD5;
  try {
    const data = await fetchHistory(apiUrl);
    sendCompactJSON(res, data);
  } catch (err) {
    res.status(500).json({ error: `Failed to fetch data for ${game}` });
  }
});

app.get('/api/predict/:game', async (req, res) => {
  const game = req.params.game === 'lc79' ? 'lc79' : 'md5';
  const apiUrl = game === 'lc79' ? API_URL_HU : API_URL_MD5;
  try {
    const history = await fetchHistory(apiUrl);
    const prediction = predictAndSave(history, game);
    sendCompactJSON(res, prediction);
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate prediction' });
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
  const initialLength = predictions.length;
  for (let i = predictions.length - 1; i >= 0; i--) {
    if (predictions[i].game === gameKey) predictions.splice(i, 1);
  }
  res.json({ message: `Deleted predictions for ${gameKey}`, removed: initialLength - predictions.length });
});

// ==================== DASHBOARD HTML ====================
app.get('/dashboard/:game', (req, res) => {
  const gameKey = req.params.game === 'lc79' ? 'lc79' : 'md5';
  const gameName = gameKey === 'lc79' ? 'Tài Xỉu Hũ' : 'Tài Xỉu MD5';
  
  const total = predictions.filter(p => p.game === gameKey).length;
  const correct = predictions.filter(p => p.game === gameKey && p.status === 'correct').length;
  const incorrect = predictions.filter(p => p.game === gameKey && p.status === 'incorrect').length;
  const pending = predictions.filter(p => p.game === gameKey && p.status === 'pending').length;
  const accuracy = (correct + incorrect) > 0 ? (correct / (correct + incorrect) * 100).toFixed(2) : 'N/A';
  const preds = predictions.filter(p => p.game === gameKey).sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  let html = `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8">
    <title>Dashboard ${gameName} - ${ADMIN_NAME}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
      h1 { color: #333; }
      .stats { display: flex; gap: 20px; flex-wrap: wrap; margin-bottom: 20px; }
      .stat-box { background: white; padding: 15px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); min-width: 100px; text-align: center; }
      .stat-box h3 { margin: 0 0 5px 0; font-size: 14px; color: #666; }
      .stat-box .value { font-size: 24px; font-weight: bold; }
      .correct { color: green; }
      .incorrect { color: red; }
      .pending { color: orange; }
      table { width: 100%; border-collapse: collapse; background: white; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
      th, td { padding: 10px; text-align: left; border-bottom: 1px solid #ddd; }
      th { background: #4CAF50; color: white; }
      tr:hover { background: #f1f1f1; }
      .filter { margin-bottom: 15px; }
      button { padding: 8px 16px; margin-right: 5px; cursor: pointer; }
      .refresh { margin-bottom: 15px; }
      @media (max-width: 600px) { .stats { flex-direction: column; } }
    </style>
  </head>
  <body>
    <h1>📊 Dashboard Dự Đoán ${gameName}</h1>
    <p>Admin: <strong>${ADMIN_NAME}</strong> | Server time: ${formatTime(new Date())}</p>
    <div class="stats">
      <div class="stat-box"><h3>Tổng dự đoán</h3><div class="value">${total}</div></div>
      <div class="stat-box"><h3>Đúng</h3><div class="value correct">${correct}</div></div>
      <div class="stat-box"><h3>Sai</h3><div class="value incorrect">${incorrect}</div></div>
      <div class="stat-box"><h3>Đang chờ</h3><div class="value pending">${pending}</div></div>
      <div class="stat-box"><h3>Tỉ lệ đúng</h3><div class="value">${accuracy}</div></div>
    </div>
    <div class="filter">
      <button onclick="window.location.href='?status='">Tất cả</button>
      <button onclick="window.location.href='?status=pending'">Đang chờ</button>
      <button onclick="window.location.href='?status=correct'">Đúng</button>
      <button onclick="window.location.href='?status=incorrect'">Sai</button>
    </div>
    <div class="refresh">
      <button onclick="location.reload()">🔄 Làm mới</button>
    </div>
    <table>
      <thead>
        <tr>
          <th>ID</th>
          <th>Phiên dự đoán</th>
          <th>Dự đoán</th>
          <th>Thực tế</th>
          <th>Trạng thái</th>
          <th>Độ tin cậy</th>
          <th>Thời gian</th>
        </tr>
      </thead>
      <tbody>
  `;

  for (const p of preds) {
    const statusClass = p.status === 'correct' ? 'correct' : (p.status === 'incorrect' ? 'incorrect' : 'pending');
    html += `
        <tr>
          <td>${p.id}</td>
          <td>${p.predictedPhien}</td>
          <td><strong>${p.prediction}</strong></td>
          <td>${p.actualKetQua || '—'}</td>
          <td class="${statusClass}">${p.status}</td>
          <td>${p.confidence}%</td>
          <td>${new Date(p.timestamp).toLocaleString()}</td>
        </tr>
    `;
  }

  html += `
      </tbody>
    </table>
    <script>
      const urlParams = new URLSearchParams(window.location.search);
      const status = urlParams.get('status');
      if (status) {
        document.querySelectorAll('.filter button').forEach(btn => {
          if (btn.textContent.toLowerCase().includes(status)) btn.style.background = '#ddd';
        });
      }
    </script>
  </body>
  </html>
  `;

  res.send(html);
});

// ==================== START SERVER ====================
app.listen(PORT, () => {
  console.log(`Server đang chạy trên cổng ${PORT}`);
  console.log(`Admin: ${ADMIN_NAME}`);
  console.log(`Tất cả thuật toán đã được gộp vào /api/predict/:game`);
  console.log(`Dashboard: /dashboard/:game`);
});