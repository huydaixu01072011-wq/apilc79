const express = require("express");
const axios = require("axios");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const URL_TRUYEN_THONG = "https://wtx.tele68.com/v1/tx/sessions";
const URL_MD5 = "https://wtxmd52.tele68.com/v1/txmd5/sessions";

const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    "Accept": "application/json, text/plain, */*",
    "Referer": "https://tele68.com/",
    "Origin": "https://tele68.com",
    "Connection": "keep-alive"
};

const http = axios.create({ timeout: 10000, headers: HEADERS });

let historyNormal = [];
let historyMd5 = [];
let predictionsNormal = [];
let predictionsMd5 = [];

// ========== THUẬT TOÁN VIP: MARKOV + PATTERN RECOGNITION ==========
class VIPPredictor {
    constructor(bac = 3) {
        this.bac = bac;
        this.transitions = new Map();
        this.historyDices = [];
        this.historyTX = []; // Lưu lịch sử TÀI/XỈU
        this.maxHistory = 60;
    }

    static chuyenLoai(diem) {
        if (diem === 1 || diem === 2) return 1;
        if (diem === 3 || diem === 4) return 2;
        return 3;
    }

    themDuLieu(rawData) {
        // Lấy danh sách tổng (Tài/Xỉu)
        this.historyTX = rawData.map(item => {
            const sum = item.dices.reduce((a, b) => a + b, 0);
            return sum >= 11 ? "TÀI" : "XỈU";
        }).reverse(); // Đảo lại để cũ trước, mới sau

        // Dữ liệu xúc xắc cho Markov
        const dice123 = [];
        for (let item of rawData.reverse()) { // Cũ trước, mới sau
            for (let d of item.dices) {
                dice123.push(VIPPredictor.chuyenLoai(d));
            }
        }
        
        this.historyDices = dice123.slice(-this.maxHistory);
        this._xayDungMaTran();
    }

    _xayDungMaTran() {
        this.transitions.clear();
        const len = this.historyDices.length;
        if (len < this.bac + 1) return;

        for (let i = this.bac; i < len; i++) {
            for (let b = 1; b <= this.bac; b++) {
                const state = [];
                for (let j = b - 1; j >= 0; j--) {
                    state.push(this.historyDices[i - j]);
                }
                const stateKey = state.join(',');
                const nextVal = this.historyDices[i];
                
                if (!this.transitions.has(stateKey)) {
                    this.transitions.set(stateKey, new Map());
                }
                const nextMap = this.transitions.get(stateKey);
                nextMap.set(nextVal, (nextMap.get(nextVal) || 0) + 1);
            }
        }
    }

    nhanDienCau() {
        const len = this.historyTX.length;
        if (len < 5) return { coCau: false };

        const last1 = this.historyTX[len - 1];
        const last2 = this.historyTX[len - 2];
        const last3 = this.historyTX[len - 3];
        const last4 = this.historyTX[len - 4];
        const last5 = this.historyTX[len - 5];

        // Nhận diện cầu Bệt (4 ván liên tiếp giống nhau)
        if (last1 === last2 && last2 === last3 && last3 === last4) {
            return { coCau: true, theLoai: "CẦU BỆT", duDoan: last1, doTinCay: 85 };
        }
        
        // Nhận diện cầu 1-1 (T-X-T-X hoặc X-T-X-T)
        if (last1 !== last2 && last2 !== last3 && last3 !== last4 && last4 !== last5) {
            return { coCau: true, theLoai: "CẦU 1-1", duDoan: last1 === "TÀI" ? "XỈU" : "TÀI", doTinCay: 80 };
        }

        // Nhận diện cầu 2-2 (T-T-X-X hoặc X-X-T-T)
        if (last1 === last2 && last2 !== last3 && last3 === last4 && last1 !== last3) {
            return { coCau: true, theLoai: "CẦU 2-2", duDoan: last1 === "TÀI" ? "XỈU" : "TÀI", doTinCay: 75 };
        }

        return { coCau: false };
    }

    duDoanMarkov() {
        if (this.historyDices.length < this.bac) return 2; // Default 3-4

        const states = [];
        for (let b = 1; b <= this.bac; b++) {
            const state = [];
            for (let j = b - 1; j >= 0; j--) {
                state.push(this.historyDices[this.historyDices.length - 1 - j]);
            }
            states.push({ bac: b, key: state.join(',') });
        }

        const diem = { 1: 0, 2: 0, 3: 0 };
        let tongDiem = 0;

        for (let i = states.length - 1; i >= 0; i--) {
            const s = states[i];
            const nextMap = this.transitions.get(s.key);
            if (nextMap && nextMap.size > 0) {
                const heSo = Math.pow(2, s.bac);
                for (let [val, count] of nextMap.entries()) {
                    diem[val] += count * heSo;
                    tongDiem += count * heSo;
                }
                break; 
            }
        }

        if (tongDiem === 0) return 2;

        let rand = Math.random() * tongDiem;
        let cum = 0;
        for (let val of [1, 2, 3]) {
            cum += diem[val];
            if (rand <= cum) return val;
        }
        return 2;
    }

    phanTich() {
        // Kiểm tra cầu trước (Ưu tiên bắt cầu)
        const checkCau = this.nhanDienCau();
        if (checkCau.coCau) {
            return {
                prediction: checkCau.duDoan,
                confidenceTai: checkCau.duDoan === "TÀI" ? checkCau.doTinCay : 100 - checkCau.doTinCay,
                confidenceXiu: checkCau.duDoan === "XỈU" ? checkCau.doTinCay : 100 - checkCau.doTinCay,
                reason: `Phát hiện ${checkCau.theLoai}, bám cầu!`,
                pattern: checkCau.theLoai
            };
        }

        // Nếu không có cầu rõ ràng, dùng Markov Chain
        const duDoanSo = this.duDoanMarkov();
        const prediction = (duDoanSo === 1 || duDoanSo === 3) ? "TÀI" : "XỈU";
        
        return {
            prediction: prediction,
            confidenceTai: prediction === "TÀI" ? 65 : 35,
            confidenceXiu: prediction === "XỈU" ? 65 : 35,
            reason: `Phân tích Markov bậc ${this.bac}, không có cầu rõ ràng.`,
            pattern: "MARKOV CHAIN"
        };
    }
}

function analyzeTrendVIP(history) {
    if (!history || history.length < 5) {
        return { prediction: "TÀI", confidenceTai: 50, confidenceXiu: 50, reason: "Đợi thêm data", pattern: "CHỜ" };
    }
    const predictor = new VIPPredictor(3);
    predictor.themDuLieu(history.slice(0, 40));
    return predictor.phanTich();
}

// ========== LOGIC LƯU LỊCH SỬ & ĐÁNH GIÁ (GIỮ NGUYÊN NHƯNG TỐI ƯU HƠN) ==========

function updatePrediction(storage, history) {
    if (history.length < 1) return;
    const latest = history[0]; 
    const nextPhien = latest.id + 1;
    
    // Kiểm tra xem đã dự đoán cho phiên tiếp theo chưa
    const existing = storage.find(p => p.phien === nextPhien);
    if (!existing) {
        const ai = analyzeTrendVIP(history);
        storage.push({
            phien: nextPhien,
            du_doan: ai.prediction,
            ket_qua: null, // Sẽ update khi có kết quả thật
            danh_gia: "ĐANG CHỜ",
            thoi_gian: new Date().toLocaleTimeString(),
            chi_tiet: ai.pattern
        });
        
        // Giữ mảng không quá lớn (giữ 50 phiên)
        if (storage.length > 50) storage.shift(); 
    }
}

function evaluate(storage, history) {
    storage.forEach(p => {
        if (p.ket_qua) return; // Đã có kết quả thì bỏ qua
        // Tìm xem lịch sử trả về đã có ID của phiên mình dự đoán chưa
        const real = history.find(h => h.id === p.phien);
        if (real && real.dices && real.dices.length === 3) {
            const sum = real.dices.reduce((a, b) => a + b, 0);
            const result = sum >= 11 ? "TÀI" : "XỈU";
            p.ket_qua = result + ` (${sum})`;
            p.danh_gia = (p.du_doan === result) ? "THẮNG" : "THUA";
        }
    });
}

function stats(storage) {
    // Chỉ tính những phiên ĐÃ CÓ KẾT QUẢ
    const finished = storage.filter(i => i.ket_qua !== null);
    const total = finished.length;
    const win = finished.filter(i => i.danh_gia === "THẮNG").length;
    const lose = finished.filter(i => i.danh_gia === "THUA").length;
    const rate = total === 0 ? 0 : ((win / total) * 100);
    return {
        tong_da_danh_gia: total,
        tong_thang: win,
        tong_thua: lose,
        ti_le_chinh_xac: `${rate.toFixed(2)}%`,
        lich_su: storage.slice(-20).reverse() // Trả về 20 phiên gần nhất, mới nhất lên đầu
    };
}

// ========== KẾT NỐI API ==========

async function fetchWithRetry(url, retry = 2) {
    try { return await http.get(url); }
    catch (e) { if (retry > 0) return fetchWithRetry(url, retry - 1); throw e; }
}

async function poll() {
    try {
        const [normal, md5] = await Promise.all([
            fetchWithRetry(URL_TRUYEN_THONG),
            fetchWithRetry(URL_MD5)
        ]);
        historyNormal = normal.data.list || [];
        historyMd5 = md5.data.list || [];
        
        // Update dự đoán cho phiên sau dựa trên lịch sử hiện tại
        updatePrediction(predictionsNormal, historyNormal);
        updatePrediction(predictionsMd5, historyMd5);
        
        // Kiểm tra xem các dự đoán cũ đã có kết quả để đánh giá chưa
        evaluate(predictionsNormal, historyNormal);
        evaluate(predictionsMd5, historyMd5);
        
    } catch (e) { console.log("Poll lỗi:", e.message); }
}
setInterval(poll, 3000); // Poll nhanh hơn (3s) để bắt dữ liệu nhạy

// ========== ROUTES & GIAO DIỆN ==========

app.get("/thongke", (req, res) => res.json(stats(predictionsNormal)));
app.get("/thongkemd5", (req, res) => res.json(stats(predictionsMd5)));

// GIAO DIỆN HIỂN THỊ
app.get("/", (req, res) => {
    const html = `
    <!DOCTYPE html>
    <html lang="vi">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>BOT AI VIP - TÀI XỈU</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <style>
            body { background-color: #0f172a; color: #f8fafc; font-family: 'Inter', sans-serif; }
            .glow-win { text-shadow: 0 0 10px #22c55e; }
            .glow-lose { text-shadow: 0 0 10px #ef4444; }
            .table-container::-webkit-scrollbar { width: 6px; }
            .table-container::-webkit-scrollbar-thumb { background: #334155; border-radius: 10px; }
        </style>
    </head>
    <body class="p-6">
        <div class="max-w-5xl mx-auto">
            <div class="text-center mb-8">
                <h1 class="text-4xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-purple-500 mb-2">HỆ THỐNG DỰ ĐOÁN AI VIP</h1>
                <p class="text-gray-400">Tự động bắt cầu & phân tích Markov Chain. Tự động làm mới sau mỗi 3 giây.</p>
            </div>

            <div class="grid grid-cols-1 lg:grid-cols-2 gap-8">
                <div class="bg-slate-800 rounded-xl p-5 shadow-2xl border border-slate-700">
                    <h2 class="text-2xl font-bold mb-4 text-blue-400">Tài Xỉu Truyền Thống</h2>
                    <div id="stats-normal" class="mb-4 flex gap-4 text-sm font-semibold text-slate-300"></div>
                    <div class="table-container max-h-[500px] overflow-y-auto rounded-lg border border-slate-700">
                        <table class="w-full text-left border-collapse">
                            <thead class="bg-slate-900 sticky top-0">
                                <tr>
                                    <th class="p-3 text-sm">Phiên</th>
                                    <th class="p-3 text-sm">Phương Pháp</th>
                                    <th class="p-3 text-sm text-center">Dự Đoán</th>
                                    <th class="p-3 text-sm text-center">Kết Quả</th>
                                    <th class="p-3 text-sm text-center">Trạng Thái</th>
                                </tr>
                            </thead>
                            <tbody id="table-normal" class="divide-y divide-slate-700"></tbody>
                        </table>
                    </div>
                </div>

                <div class="bg-slate-800 rounded-xl p-5 shadow-2xl border border-slate-700">
                    <h2 class="text-2xl font-bold mb-4 text-purple-400">Tài Xỉu MD5</h2>
                    <div id="stats-md5" class="mb-4 flex gap-4 text-sm font-semibold text-slate-300"></div>
                    <div class="table-container max-h-[500px] overflow-y-auto rounded-lg border border-slate-700">
                        <table class="w-full text-left border-collapse">
                            <thead class="bg-slate-900 sticky top-0">
                                <tr>
                                    <th class="p-3 text-sm">Phiên</th>
                                    <th class="p-3 text-sm">Phương Pháp</th>
                                    <th class="p-3 text-sm text-center">Dự Đoán</th>
                                    <th class="p-3 text-sm text-center">Kết Quả</th>
                                    <th class="p-3 text-sm text-center">Trạng Thái</th>
                                </tr>
                            </thead>
                            <tbody id="table-md5" class="divide-y divide-slate-700"></tbody>
                        </table>
                    </div>
                </div>
            </div>
        </div>

        <script>
            function renderRow(item) {
                let statusClass = "text-yellow-400";
                if(item.danh_gia === "THẮNG") statusClass = "text-green-500 font-bold glow-win";
                if(item.danh_gia === "THUA") statusClass = "text-red-500 font-bold glow-lose";
                
                return \`
                    <tr class="hover:bg-slate-700/50 transition-colors">
                        <td class="p-3 text-sm font-mono text-gray-400">#\${item.phien}</td>
                        <td class="p-3 text-xs text-indigo-300">\${item.chi_tiet}</td>
                        <td class="p-3 text-sm text-center font-bold text-white">\${item.du_doan}</td>
                        <td class="p-3 text-sm text-center font-bold text-gray-300">\${item.ket_qua || "..."}</td>
                        <td class="p-3 text-sm text-center \${statusClass}">\${item.danh_gia}</td>
                    </tr>
                \`;
            }

            async function fetchData() {
                try {
                    const [resNormal, resMd5] = await Promise.all([
                        fetch('/thongke').then(r => r.json()),
                        fetch('/thongkemd5').then(r => r.json())
                    ]);

                    document.getElementById('stats-normal').innerHTML = \`
                        <span class="bg-slate-700 px-2 py-1 rounded">Đã Đánh Giá: \${resNormal.tong_da_danh_gia}</span>
                        <span class="bg-green-900/50 text-green-400 px-2 py-1 rounded">Thắng: \${resNormal.tong_thang}</span>
                        <span class="bg-red-900/50 text-red-400 px-2 py-1 rounded">Tỷ lệ: \${resNormal.ti_le_chinh_xac}</span>
                    \`;
                    document.getElementById('table-normal').innerHTML = resNormal.lich_su.map(renderRow).join('');

                    document.getElementById('stats-md5').innerHTML = \`
                        <span class="bg-slate-700 px-2 py-1 rounded">Đã Đánh Giá: \${resMd5.tong_da_danh_gia}</span>
                        <span class="bg-green-900/50 text-green-400 px-2 py-1 rounded">Thắng: \${resMd5.tong_thang}</span>
                        <span class="bg-red-900/50 text-red-400 px-2 py-1 rounded">Tỷ lệ: \${resMd5.ti_le_chinh_xac}</span>
                    \`;
                    document.getElementById('table-md5').innerHTML = resMd5.lich_su.map(renderRow).join('');

                } catch(e) {
                    console.error("Lỗi lấy dữ liệu:", e);
                }
            }

            setInterval(fetchData, 3000);
            fetchData();
        </script>
    </body>
    </html>
    `;
    res.send(html);
});

app.listen(PORT, () => console.log(`🚀 Server chạy cổng ${PORT} - Giao diện VIP tại http://localhost:${PORT}`));
