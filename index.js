const express = require("express");
const axios = require("axios");

const app = express();

const LC79 = "https://wtx.tele68.com/v1/tx/sessions";
const LC79MD5 = "https://wtxmd52.tele68.com/v1/txmd5/sessions";

/* ===========================
   PHÂN TÍCH SIÊU CẦU
=========================== */

function analyze(data){

    const results = data.map(x => x.resultTruyenThong);

    let followScore = 0;
    let breakScore = 0;

    /* ===== Cầu bệt ===== */
    let streak = 1;
    for(let i=1;i<results.length;i++){
        if(results[i] === results[i-1]) streak++;
        else break;
    }

    if(streak >= 3) followScore += 3;
    else breakScore += 2;

    /* ===== cầu 1-1 ===== */
    let zigzag = true;
    for(let i=2;i<8;i++){
        if(results[i] === results[i-1]){
            zigzag = false;
            break;
        }
    }

    if(zigzag) breakScore += 3;

    /* ===== thống kê 10 phiên ===== */
    const last10 = results.slice(0,10);
    const tai = last10.filter(x=>x==="TAI").length;
    const xiu = last10.filter(x=>x==="XIU").length;

    if(tai > xiu) followScore++;
    else breakScore++;

    /* ===== momentum đổi cầu ===== */
    if(results[0] !== results[1])
        breakScore += 2;
    else
        followScore += 2;

    /* ===================== */

    const last = results[0];

    let predict;

    if(followScore >= breakScore){
        predict = last; // theo cầu
    }else{
        predict = last === "TAI" ? "XIU" : "TAI"; // bẻ cầu
    }

    const confidence =
        Math.min(
            99,
            50 + Math.abs(followScore-breakScore)*10
        );

    return {
        predict,
        confidence
    };
}

/* ===========================
   FORMAT JSON OUTPUT
=========================== */

function buildJSON(list, analysis){

    const last = list[0];

    return {
        phien: last.id,
        xuc_xac_1: last.dices[0],
        xuc_xac_2: last.dices[1],
        xuc_xac_3: last.dices[2],
        tong: last.point,
        ket_qua: last.resultTruyenThong === "TAI" ? "TÀI" : "XỈU",
        phien_hien_tai: last.id + 1,
        du_doan: analysis.predict === "TAI" ? "TÀI" : "XỈU",
        do_tin_cay: analysis.confidence + "%"
    };
}

/* ===========================
   SERVER INFO
=========================== */

app.get("/", (req, res) => {
    res.json({
        name: "LC79 AI Predictor",
        status: "ONLINE",
        author: "HuyDaiXu AI",
        time: new Date().toLocaleString(),
        endpoints: [
            "/api/lc79",
            "/api/lc79md5"
        ]
    });
});

/* ===========================
   API LC79
=========================== */

app.get("/api/lc79", async (req,res)=>{
    try{

        const r = await axios.get(LC79);

        const list = r.data.list;

        const analysis = analyze(list);

        res.json(
            buildJSON(list,analysis)
        );

    }catch(e){
        res.json({error:e.message});
    }
});

/* ===========================
   API LC79 MD5
=========================== */

app.get("/api/lc79md5", async (req,res)=>{
    try{

        const r = await axios.get(LC79MD5);

        const list = r.data.list;

        const analysis = analyze(list);

        res.json(
            buildJSON(list,analysis)
        );

    }catch(e){
        res.json({error:e.message});
    }
});

/* =========================== */

app.listen(3000,()=>{
    console.log("LC79 AI Predictor Running");
});