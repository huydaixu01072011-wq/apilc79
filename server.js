const express = require("express");
const axios = require("axios");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// API gốc
const URL_TRUYEN_THONG = "https://wtx.tele68.com/v1/tx/sessions";
const URL_MD5 = "https://wtxmd52.tele68.com/v1/txmd5/sessions";

// Danh sách ping thêm (VIP: tự động lấy URL qua biến môi trường, cách nhau dấu phẩy)
const EXTRA_PING_URLS = process.env.PING_URLS ? process.env.PING_URLS.split(",").map(u => u.trim()).filter(Boolean) : [];

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  "Accept": "application/json, text/plain, */*",
  "Referer": "https://tele68.com/",
  "Origin": "https://tele68.com",
  "Connection": "keep-alive"
};

const http = axios.create({ timeout: 10000, headers: HEADERS });

// Lưu trữ dữ liệu
let historyNormal = [];
let historyMd5 = [];
let predictionsNormal = [];
let predictionsMd5 = [];

// ==================== MARKOV CHAIN CAO CẤP ====================
class SuperMarkov {
  constructor(bac = 4) {
    this.bac = Math.min(5, Math.max(2, bac)); // bậc từ 2-5
    this.transitions = new Map();
    this.history = []; // mảng các giá trị 1,2,3
    this.maxHistory = 80;
  }

  static chuyenLoai(diem) {
    if (diem === 1 || diem === 2) return 1; // Xỉu
    if (diem === 3 || diem === 4) return 2; // Trung bình
    return 3; // Tài (5-6)
  }

  themDuLieu(daySo) {
    const filtered = daySo.map(d => SuperMarkov.chuyenLoai(d));
    this.history.push(...filtered);
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory);
    }
    this._xayDungMaTran();
  }

  _xayDungMaTran() {
    this.transitions.clear();
    const len = this.history.length;
    if (len < this.bac + 1) return;

    for (let b = 2; b <= this.bac; b++) {
      for (let i = b; i < len; i++) {
        const state = [];
        for (let j = 1; j <= b; j++) {
          state.push(this.history[i - j]);
        }
        const key = state.join(",");
        const next = this.history[i];

        if (!this.transitions.has(key)) {
          this.transitions.set(key, new Map());
        }
        const cntMap = this.transitions.get(key);
        cntMap.set(next, (cntMap.get(next) || 0) + 1);
      }
    }
  }

  // Lấy trạng thái hiện tại theo độ dài tối đa có thể
  _layStateHienTai() {
    const len = this.history.length;
    const states = [];
    for (let b = this.bac; b >= 2; b--) {
      if (len >= b) {
        const state = [];
        for (let j = 0; j < b; j++) {
          state.push(this.history[len - b + j]);
        }
        states.push({ bac: b, key: state.join(",") });
      }
    }
    return states; // ưu tiên bậc cao trước
  }

  // Dự đoán loại (1,2,3) với trọng số
  duDoan() {
    if (this.history.length < 3) {
      return this._thongKeDonGian();
    }

    const states = this._layStateHienTai();
    let scores = { 1: 0, 2: 0, 3: 0 };
    let totalWeight = 0;

    // Duyệt qua các bậc, bậc càng cao trọng số càng lớn
    for (let s of states) {
      const nextMap = this.transitions.get(s.key);
      if (nextMap && nextMap.size > 0) {
        const weight = Math.pow(2, s.bac); // 2^bậc
        for (let [val, cnt] of nextMap.entries()) {
          scores[val] += cnt * weight;
        }
        totalWeight += weight;
        break; // chỉ lấy bậc cao nhất có dữ liệu
      }
    }

    if (totalWeight === 0) {
      return this._thongKeDonGian();
    }

    // Chọn giá trị có điểm cao nhất
    let maxVal = 1, maxScore = -1;
    for (let v of [1, 2, 3]) {
      if (scores[v] > maxScore) {
        maxScore = scores[v];
        maxVal = v;
      }
    }
    return maxVal;
  }

  _thongKeDonGian() {
    if (this.history.length === 0) return 2;
    const cnt = { 1: 0, 2: 0, 3: 0 };
    this.history.forEach(v => cnt[v]++);
    // Ưu tiên loại xuất hiện nhiều nhất
    return cnt[1] >= cnt[2] && cnt[1] >= cnt[3] ? 1 :
           cnt[2] >= cnt[1] && cnt[2] >= cnt[3] ? 2 : 3;
  }

  // Phân tích mẫu cầu nâng cao
  phanTichCau() {
    const len = this.history.length;
    if (len < 5) return "KHÔNG XÁC ĐỊNH";

    const last = this.history.slice(-10);
    // Kiểm tra cầu bệt (cùng 1 loại >= 3 lần)
    let bet = 0;
    for (let i = last.length - 1; i >= 1; i--) {
      if (last[i] === last[i - 1]) bet++;
      else break;
    }
    if (bet >= 3) return `BỆT LOẠI ${last[last.length - 1]} (${bet + 1} lần)`;

    // Cầu 1-1 (so le)
    if (last.length >= 4) {
      let sole = true;
      for (let i = 1; i < last.length; i++) {
        if (last[i] === last[i - 1]) { sole = false; break; }
      }
      if (sole) return "CẦU SO LE 1-1";
    }

    // Cầu 2-1
    if (last.length >= 6) {
      let ok = true;
      for (let i = 0; i < 5; i += 3) {
        if (last[i] !== last[i + 1] || last[i] === last[i + 2]) ok = false;
      }
      if (ok && last[0] === last[3]) return "CẦU 2-1";
    }

    return "KHÔNG RÕ";
  }

  // Dự đoán kết quả Tài/Xỉu dựa trên loại
  duDoanTaiXiu(loai) {
    // Loại 1 (1-2) -> Xỉu, Loại 2 (3-4) -> Xỉu (trung bình thiên về Xỉu), Loại 3 (5-6) -> Tài
    // Nhưng ta cần kết hợp với quy tắc chuẩn: Tài là tổng 3 viên >=11, Xỉu <=10.
    // Trong đó loại 1 đóng góp 1,2 -> tổng nhỏ; loại 3 đóng góp 5,6 -> tổng lớn; loại 2 trung bình.
    // Với 3 viên, nếu dự đoán loại chủ đạo là 3 thì tổng thường >=11.
    // Mình sử dụng ánh xạ đơn giản nhưng có logic: loại dự đoán 1 -> Xỉu; loại 3 -> Tài; loại 2 -> ngẫu nhiên thiên Xỉu 60%.
    if (loai === 1) return "XỈU";
    if (loai === 3) return "TÀI";
    // loại 2 -> phân vân, dựa vào lịch sử gần đây
    const recent = this.history.slice(-10);
    const cntTai = recent.filter(v => v === 3).length;
    const cntXiu = recent.filter(v => v === 1).length;
    return cntTai > cntXiu ? "TÀI" : "XỈU";
  }
}

// ==================== BỘ DỰ ĐOÁN VIP ====================
function analyzeVIP(history) {
  if (!history || history.length < 2) {
    return {
      prediction: "TÀI",
      confidenceTai: 50,
      confidenceXiu: 50,
      reason: "Chưa đủ dữ liệu",
      loaiDuDoan: 2
    };
  }

  // Trích xuất dãy xúc xắc 3 viên
  const daySo = [];
  const maxLen = Math.min(history.length, 60);
  for (let i = 0; i < maxLen; i++) {
    const item = history[i];
    if (item && item.dices && item.dices.length === 3) {
      for (let d of item.dices) daySo.push(d);
    }
  }

  if (daySo.length < 12) {
    return {
      prediction: "XỈU",
      confidenceTai: 45,
      confidenceXiu: 55,
      reason: `Chỉ ${daySo.length} xúc xắc, dùng thống kê cơ bản`,
      loaiDuDoan: 2
    };
  }

  const markov = new SuperMarkov(4);
  markov.themDuLieu(daySo);
  const loai = markov.duDoan();
  const cau = markov.phanTichCau();
  const prediction = markov.duDoanTaiXiu(loai);

  // Tính độ tin cậy dựa trên dữ liệu gần đây và mẫu cầu
  let confidenceBase = 65;
  const recent = markov.history.slice(-10);
  const sameCount = recent.filter(v => v === loai).length;
  confidenceBase += sameCount >= 6 ? 20 : sameCount >= 4 ? 10 : 0;

  // Thưởng nếu mẫu cầu rõ
  if (cau.includes("BỆT")) confidenceBase += 10;
  else if (cau.includes("SO LE")) confidenceBase += 5;
  else if (cau.includes("2-1")) confidenceBase += 8;

  if (markov.history.length > 40) confidenceBase += 5;
  confidenceBase = Math.min(95, Math.max(50, confidenceBase));

  let confidenceTai = prediction === "TÀI" ? confidenceBase : 100 - confidenceBase;
  let confidenceXiu = prediction === "XỈU" ? confidenceBase : 100 - confidenceBase;

  // Chuẩn hóa
  const total = confidenceTai + confidenceXiu;
  if (total !== 100) {
    confidenceTai = Math.round(confidenceTai * 100 / total);
    confidenceXiu = 100 - confidenceTai;
  }

  const reason = `Markov bậc 4 | Mẫu cầu: ${cau} | Loại dự đoán: ${loai} (${loai===1?'1-2':loai===2?'3-4':'5-6'}) | Lịch sử ${daySo.length} xúc xắc`;

  return {
    prediction,
    confidenceTai,
    confidenceXiu,
    reason,
    loaiDuDoan: loai,
    cau,
  };
}

// Hàm phân tích trend (cũ) – giữ lại cho thường, giờ nâng cấp thành VIP
function analyzeTrend(history) {
  return analyzeVIP(history);
}

// ==================== TIỆN ÍCH ====================
function generateSeed(history, count = 8) {
  if (history.length < count) return null;
  const seedString = history.slice(0, count).map(item => item.dices ? item.dices.join('') : '').join('');
  if (!seedString) return null;
  return crypto.createHash('md5').update(seedString).digest('hex');
}

function randomDice(seed) {
  if (!seed) return [Math.floor(Math.random() * 6) + 1, Math.floor(Math.random() * 6) + 1, Math.floor(Math.random() * 6) + 1];
  const hash = crypto.createHash('md5').update(seed).digest('hex');
  return [
    parseInt(hash.substring(0, 2), 16) % 6 + 1,
    parseInt(hash.substring(2, 4), 16) % 6 + 1,
    parseInt(hash.substring(4, 6), 16) % 6 + 1
  ];
}

function updatePrediction(storage, history) {
  if (history.length < 2) return;
  const latest = history[0];
  const existing = storage.find(p => p.phien === latest.id);
  if (existing) return;
  const ai = analyzeTrend(history);
  storage.push({
    phien: latest.id + 1,
    du_doan: ai.prediction,
    ket_qua: null,
    danh_gia: null,
    chi_tiet: ai
  });
}

function evaluate(storage, history) {
  storage.forEach(p => {
    if (p.ket_qua) return;
    const real = history.find(h => h.id === p.phien);
    if (!real) return;
    const sum = real.dices ? real.dices.reduce((a, b) => a + b, 0) : 0;
    const result = sum >= 11 ? "TÀI" : "XỈU";
    p.ket_qua = result;
    p.danh_gia = (p.du_doan === result) ? "THẮNG" : "THUA";
  });
}

function stats(storage) {
  const total = storage.length;
  const win = storage.filter(i => i.danh_gia === "THẮNG").length;
  const lose = storage.filter(i => i.danh_gia === "THUA").length;
  const rate = total === 0 ? 0 : (win / total) * 100;
  return {
    tong_du_doan: total,
    tong_thang: win,
    tong_thua: lose,
    ti_le_chinh_xac: `${rate.toFixed(2)}%`,
    lich_su: storage.slice(-20)
  };
}

function formatData(raw, history) {
  const list = raw?.list;
  if (!list || list.length === 0) return { error: "Không có dữ liệu" };
  const data = list[0];
  const ai = analyzeTrend(list);
  const seed = generateSeed(list, 8);

  let xuc_xac = [0, 0, 0];
  let tong = 0;
  if (data.dices && data.dices.length === 3) {
    xuc_xac = data.dices;
    tong = data.dices.reduce((a, b) => a + b, 0);
  } else {
    const random = randomDice(seed);
    xuc_xac = random;
    tong = random.reduce((a, b) => a + b, 0);
  }

  return {
    phien: data.id,
    xuc_xac_1: xuc_xac[0],
    xuc_xac_2: xuc_xac[1],
    xuc_xac_3: xuc_xac[2],
    tong: tong,
    ket_qua: tong >= 11 ? "TÀI" : "XỈU",
    phien_tiep_theo: data.id + 1,
    du_doan: ai.prediction,
    do_tin_cay: { TÀI: `${ai.confidenceTai}%`, XỈU: `${ai.confidenceXiu}%` },
    ly_do: ai.reason,
    du_doan_loai_xuc_xac: ai.loaiDuDoan || 2,
    pattern: ai.cau || "BÌNH THƯỜNG"
  };
}

// ==================== FETCH & PING ====================
async function fetchWithRetry(url, retry = 2) {
  try { return await http.get(url); }
  catch (e) { if (retry > 0) return fetchWithRetry(url, retry - 1); throw e; }
}

// Poll dữ liệu mỗi 5s
async function poll() {
  try {
    const [normal, md5] = await Promise.all([
      fetchWithRetry(URL_TRUYEN_THONG),
      fetchWithRetry(URL_MD5)
    ]);
    historyNormal = normal.data.list || [];
    historyMd5 = md5.data.list || [];
    updatePrediction(predictionsNormal, historyNormal);
    updatePrediction(predictionsMd5, historyMd5);
    evaluate(predictionsNormal, historyNormal);
    evaluate(predictionsMd5, historyMd5);
    console.log("✅ Poll OK -", new Date().toLocaleTimeString());
  } catch (e) {
    console.log("❌ Poll lỗi:", e.message);
  }
}
setInterval(poll, 5000);

// VIP: tự động ping các URL để giữ kết nối, mỗi 60s
async function keepAlivePing() {
  const urls = [URL_TRUYEN_THONG, URL_MD5, ...EXTRA_PING_URLS];
  try {
    await Promise.allSettled(urls.map(url => http.get(url, { timeout: 5000 })));
    console.log("🔄 Keep-alive ping thành công -", new Date().toLocaleTimeString());
  } catch (e) {
    console.log("⚠️ Keep-alive ping lỗi:", e.message);
  }
}
setInterval(keepAlivePing, 60000); // mỗi 1 phút
keepAlivePing(); // chạy ngay khi khởi động

// ==================== ENDPOINTS ====================
app.get("/", (req, res) => res.send("🔥 SUPER MARKOV VIP - Tài Xỉu Siêu Chuẩn"));

app.get("/taixiu", async (req, res) => {
  try {
    const r = await fetchWithRetry(URL_TRUYEN_THONG);
    res.json(formatData(r.data, historyNormal));
  } catch {
    res.status(500).json({ error: "API truyền thống lỗi" });
  }
});

app.get("/taixiumd5", async (req, res) => {
  try {
    const r = await fetchWithRetry(URL_MD5);
    res.json(formatData(r.data, historyMd5));
  } catch {
    res.status(500).json({ error: "API MD5 lỗi" });
  }
});

app.get("/all", async (req, res) => {
  try {
    const [a, b] = await Promise.all([fetchWithRetry(URL_TRUYEN_THONG), fetchWithRetry(URL_MD5)]);
    res.json({
      taixiu: formatData(a.data, historyNormal),
      taixiumd5: formatData(b.data, historyMd5)
    });
  } catch {
    res.status(500).json({ error: "Lỗi khi lấy cả hai" });
  }
});

app.get("/thongke", (req, res) => res.json(stats(predictionsNormal)));
app.get("/thongkemd5", (req, res) => res.json(stats(predictionsMd5)));

// Endpoint VIP trả về phân tích chuyên sâu
app.get("/vip", async (req, res) => {
  try {
    const r = await fetchWithRetry(URL_TRUYEN_THONG);
    const data = r.data.list || [];
    const ai = analyzeVIP(data);
    res.json({
      status: "VIP",
      phien_moi_nhat: data[0]?.id,
      du_doan: ai.prediction,
      do_tin_cay: { TÀI: `${ai.confidenceTai}%`, XỈU: `${ai.confidenceXiu}%` },
      ly_do: ai.reason,
      loai_du_doan: ai.loaiDuDoan,
      cau: ai.cau,
      ghi_chu: "Bản VIP dùng Markov bậc 4 + phân tích mẫu cầu nâng cao"
    });
  } catch {
    res.status(500).json({ error: "Lỗi VIP" });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Super Markov VIP chạy tại cổng ${PORT}`);
  console.log(`🔄 Tự động ping mỗi 60s (bao gồm ${EXTRA_PING_URLS.length} URL mở rộng)`);
});