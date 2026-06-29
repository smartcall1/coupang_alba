/**
 * 쿠팡 파트너스 일일 리포트 — 독립 실행 버전 (Termux용)
 *
 * 사용법:
 *   node report.js              # 어제 날짜 리포트 (폴링 모드)
 *   node report.js --test       # API 응답 raw 덤프
 *   node report.js --date 2026-06-28
 */

require('dotenv').config();
const axios  = require('axios');
const moment = require('moment');
const crypto = require('crypto');

const ACCESS_KEY = process.env.COUPANG_ACCESS_KEY;
const SECRET_KEY = process.env.COUPANG_SECRET_KEY;
const BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID    = process.env.TELEGRAM_CHAT_ID;
const DOMAIN     = 'https://api-gateway.coupang.com';

const POLL_INTERVAL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS     = 42;

// ─── HMAC 인증 ───────────────────────────────────────────────────────────────
function generateHmac(method, url, secretKey, accessKey) {
    const [path, query] = url.split(/\?/);
    const datetime  = moment.utc().format('YYMMDD[T]HHmmss[Z]');
    const message   = `${datetime}${method}${path}${query || ''}`;
    const signature = crypto.createHmac('sha256', secretKey).update(message).digest('hex');
    return `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${datetime}, signature=${signature}`;
}

// ─── 날짜 유틸 ───────────────────────────────────────────────────────────────
function getYesterdayKST() {
    const kst = new Date(Date.now() + 9 * 3600000);
    kst.setDate(kst.getDate() - 1);
    return kst.toISOString().slice(0, 10);
}

function nowKST() {
    return new Date(Date.now() + 9 * 3600000)
        .toISOString().replace('T', ' ').slice(0, 16) + ' KST';
}

function fmt(n) {
    return Math.round(n).toLocaleString('ko-KR');
}

// ─── API 호출 ─────────────────────────────────────────────────────────────────
// 쿠팡 파트너스 리포트 API 엔드포인트 후보 (공식 문서 미공개 → 검증 필요)
const REPORT_ENDPOINTS = [
    '/v2/providers/affiliate_open_api/apis/openapi/v1/report/revenue',
    '/v2/providers/affiliate_open_api/apis/openapi/v1/report/income',
    '/v2/providers/affiliate_open_api/apis/openapi/v1/report/daily',
    '/v2/providers/affiliate_open_api/apis/openapi/v1/revenue',
    '/v2/providers/affiliate_open_api/apis/openapi/v1/report',
];

async function callApi(apiPath, date) {
    const method = 'GET';
    const query  = `startDate=${date}&endDate=${date}`;
    const auth   = generateHmac(method, `${apiPath}?${query}`, SECRET_KEY, ACCESS_KEY);
    const res    = await axios.get(`${DOMAIN}${apiPath}`, {
        params:  { startDate: date, endDate: date },
        headers: { Authorization: auth },
        timeout: 15000,
    });
    return res.data;
}

async function fetchOrders(date) {
    return callApi(REPORT_ENDPOINTS[0], date);
}

// --test 모드에서 후보 엔드포인트 전체 탐색
async function probeEndpoints(date) {
    for (const ep of REPORT_ENDPOINTS) {
        process.stdout.write(`\n🔍 시도: ${ep}\n`);
        try {
            const data = await callApi(ep, date);
            console.log('✅ 응답:\n' + JSON.stringify(data, null, 2));
        } catch (e) {
            const msg = e.response?.data ? JSON.stringify(e.response.data) : e.message;
            console.log('❌ ' + msg);
        }
    }
}

// ─── 카테고리 추론 ────────────────────────────────────────────────────────────
const CATEGORIES = [
    { keys: ['가전','냉장','세탁','청소','에어컨','제습','공기청정','건조기','전자레인지'], emoji: '🏠', label: '가전' },
    { keys: ['휴대폰','스마트폰','갤럭시','아이폰','태블릿','노트북','모니터','이어폰','카메라','전자'], emoji: '💻', label: '전자제품' },
    { keys: ['식빵','빵','쌀','국','반찬','김치','간장','된장','고추장','참치','사과','토마토','이유식','삼다수','음료','과자','라면','두부','콩','식품'], emoji: '🍱', label: '식품' },
    { keys: ['강아지','고양이','펫','반려','사료','모래','급여기','드라이룸'], emoji: '🐾', label: '반려동물' },
    { keys: ['스킨','로션','크림','클렌징','세럼','마스크','립','선크림','화장','뷰티'], emoji: '💄', label: '뷰티' },
    { keys: ['비타민','콜라겐','멜라토닌','유산균','오메가','홍삼','영양제','건강'], emoji: '💊', label: '건강식품' },
    { keys: ['티셔츠','바지','원피스','재킷','코트','운동화','신발','속옷','브라','패션','의류'], emoji: '👗', label: '패션/의류' },
    { keys: ['도서','수학','영어','과학','문제집','참고서','소설','만화','책'], emoji: '📚', label: '도서' },
    { keys: ['장난감','포켓몬','레고','보드게임','완구','피규어'], emoji: '🎮', label: '취미/완구' },
    { keys: ['세제','칫솔','치약','샴푸','바디워시','수건','주방','생활'], emoji: '🧴', label: '생활용품' },
];

function guessCategory(name) {
    for (const cat of CATEGORIES) {
        if (cat.keys.some(k => name.includes(k))) return cat;
    }
    return { emoji: '🛍️', label: '기타' };
}

// ─── 파싱 ────────────────────────────────────────────────────────────────────
function parseReport(rows) {
    let totalRevenue = 0, totalSales = 0, totalOrders = 0,
        totalClicks  = 0, totalCancelled = 0;
    const channelMap  = {};
    const productMap  = {};
    const categoryMap = {};
    const fullCancels = [];

    for (const row of rows) {
        const rev       = Number(row.commission       || row.revenue    || row.수익     || 0);
        const sale      = Number(row.orderPrice       || row.sales      || row.매출액   || 0);
        const qty       = Number(row.orderCount       || row.quantity   || row.판매수량 || 0);
        const clicks    = Number(row.clicks           || row.clickCount || row.클릭수   || 0);
        const cancelRev = Number(row.cancelCommission || row.cancelRev  || row.취소수익 || 0);
        const cancelQty = Number(row.cancelCount      || row.cancelQty  || row.취소수량 || 0);

        const rawCh  = row.subId || row.channelId || row.채널ID || '';
        const chKey  = rawCh.trim() !== '' ? rawCh.trim() : '📌기본(채널없음)';
        const pName  = row.productName || row.상품명 || row.name || '(상품명 없음)';
        const pId    = row.productId   || row.상품ID  || row.id  || pName;
        const apiCat = row.categoryName || row.category || row.카테고리 || null;
        const cat    = apiCat ? { emoji: '🏷️', label: apiCat } : guessCategory(pName);

        const netRev = rev - cancelRev;
        totalRevenue   += netRev;
        totalSales     += sale;
        totalOrders    += qty;
        totalClicks    += clicks;
        totalCancelled += cancelQty;

        if (!channelMap[chKey])  channelMap[chKey]  = { revenue: 0, orders: 0 };
        channelMap[chKey].revenue  += netRev;
        channelMap[chKey].orders   += qty;

        if (!productMap[pId])    productMap[pId]    = { name: pName, revenue: 0, qty: 0 };
        productMap[pId].revenue    += netRev;
        productMap[pId].qty        += qty;

        if (!categoryMap[cat.label]) categoryMap[cat.label] = { emoji: cat.emoji, revenue: 0, orders: 0 };
        categoryMap[cat.label].revenue += netRev;
        categoryMap[cat.label].orders  += qty;

        if (cancelQty > 0 && qty === cancelQty) {
            fullCancels.push(`• ${pName} ${cancelQty}건`);
        }
    }

    const convRate = totalClicks > 0
        ? ((totalOrders / totalClicks) * 100).toFixed(2) : '0.00';

    const top5 = Object.values(productMap)
        .sort((a, b) => b.revenue - a.revenue).slice(0, 5);

    const channelLines = Object.entries(channelMap)
        .sort(([, a], [, b]) => b.revenue - a.revenue)
        .map(([ch, v]) => `• ${ch}  ₩${fmt(v.revenue)} (${v.orders}건)`);

    const categoryLines = Object.entries(categoryMap)
        .sort(([, a], [, b]) => b.revenue - a.revenue)
        .map(([label, v]) => `${v.emoji} ${label}  ₩${fmt(v.revenue)} (${v.orders}건)`);

    return { totalRevenue, totalSales, totalOrders, totalClicks,
             convRate, top5, channelLines, categoryLines, fullCancels };
}

// ─── 메시지 포맷 ──────────────────────────────────────────────────────────────
function buildMessage(date, s) {
    const L = [
        `📊 <b>쿠팡파트너스 일일 리포트</b>`,
        `📅 ${date} (어제)`,
        ``,
        `💰 수익:     <b>₩${fmt(s.totalRevenue)}</b>`,
        `🛒 구매건수: ${fmt(s.totalOrders)}건`,
        `💳 합산매출: ₩${fmt(s.totalSales)}`,
        `👆 클릭수:   ${fmt(s.totalClicks)}`,
        `📈 전환율:   ${s.convRate}%`,
    ];

    if (s.top5.length > 0) {
        L.push(``, `─────────────────────`, `🏆 TOP ${s.top5.length} 상품`);
        s.top5.forEach((p, i) => {
            const name = p.name.length > 16 ? p.name.slice(0, 15) + '…' : p.name;
            L.push(`${i + 1}. ${name}  ₩${fmt(p.revenue)}`);
        });
    }

    if (s.categoryLines.length > 0) {
        L.push(``, `─────────────────────`, `📂 카테고리별 수익`);
        L.push(...s.categoryLines.slice(0, 8));
    }

    if (s.fullCancels.length > 0) {
        L.push(``, `─────────────────────`, `⚠️ 전량취소 상품`);
        L.push(...s.fullCancels.slice(0, 5));
    }

    if (s.channelLines.length > 0) {
        L.push(``, `─────────────────────`, `📡 채널별 실적`);
        L.push(...s.channelLines.slice(0, 10));
    }

    L.push(``, `─────────────────────`, `🕐 조회: ${nowKST()}`);
    return L.join('\n');
}

// ─── 텔레그램 ─────────────────────────────────────────────────────────────────
async function clearCommands() {
    if (!BOT_TOKEN) return;
    try {
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/setMyCommands`, { commands: [] });
        console.log('🧹 텔레그램 커맨드 버튼 초기화 완료');
    } catch (e) {
        console.warn('⚠️ 커맨드 초기화 실패 (무시)');
    }
}

async function sendTelegram(text) {
    if (!BOT_TOKEN || !CHAT_ID) {
        console.log('\n[텔레그램 미설정] 콘솔 출력:\n' + text.replace(/<\/?b>/g, ''));
        return;
    }
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        chat_id: CHAT_ID, text, parse_mode: 'HTML',
    });
    console.log('✅ 텔레그램 발송 완료');
}

// ─── 메인 ─────────────────────────────────────────────────────────────────────
async function main() {
    if (!ACCESS_KEY || !SECRET_KEY) {
        console.error('❌ .env에 COUPANG_ACCESS_KEY / COUPANG_SECRET_KEY 없음');
        process.exit(1);
    }

    const args    = process.argv.slice(2);
    const isTest  = args.includes('--test');
    const dateIdx = args.indexOf('--date');
    const date    = dateIdx >= 0 ? args[dateIdx + 1] : getYesterdayKST();

    console.log(`[쿠팡 리포트] 대상 날짜: ${date}`);
    await clearCommands();

    if (isTest) {
        console.log('[TEST] 후보 엔드포인트 전체 탐색\n');
        await probeEndpoints(date);
        return;
    }

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const t = new Date(Date.now() + 9 * 3600000).toISOString().slice(11, 16);
        console.log(`[${t} KST] 시도 ${attempt}/${MAX_ATTEMPTS}...`);

        try {
            const raw  = await fetchOrders(date);
            const rows = raw?.data || raw?.orders || raw?.result || (Array.isArray(raw) ? raw : null);

            if (!rows || rows.length === 0) {
                console.log('   ⏳ 데이터 없음. 10분 후 재시도...');
            } else {
                const s = parseReport(rows);
                console.log(`   📦 ${rows.length}개 row | 수익:₩${fmt(s.totalRevenue)} 건수:${s.totalOrders} 매출:₩${fmt(s.totalSales)}`);

                const done = s.totalRevenue > 0 && s.totalOrders > 0 && s.totalSales > 0;
                if (!done) {
                    console.log('   ⏳ 집계 중 (수익/건수/매출 중 0 있음). 10분 후 재시도...');
                } else {
                    await sendTelegram(buildMessage(date, s));
                    break;
                }
            }
        } catch (err) {
            console.error(`   ❌ ${err.response?.data ? JSON.stringify(err.response.data) : err.message}`);
        }

        if (attempt < MAX_ATTEMPTS) {
            await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
        } else {
            await sendTelegram(`⚠️ <b>쿠팡 리포트 조회 실패</b>\n📅 ${date}\n7시간 동안 데이터 미수신\n🕐 ${nowKST()}`);
        }
    }
}

main().catch(e => { console.error('오류:', e.message); process.exit(1); });
