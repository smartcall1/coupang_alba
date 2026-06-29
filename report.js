/**
 * 쿠팡 파트너스 일일 리포트 — Termux용
 *
 * 사용법:
 *   node report.js              # 어제 날짜 폴링 모드
 *   node report.js --test       # API raw 응답 덤프 (필드명 확인용)
 *   node report.js --date 2026-06-28
 *
 * .env 필수 항목:
 *   COUPANG_COOKIE_SID=...
 *   COUPANG_COOKIE_CT_AT=...
 *   COUPANG_COOKIE_AFATK=...
 *   TELEGRAM_BOT_TOKEN=...
 *   TELEGRAM_CHAT_ID=...
 */

require('dotenv').config();
const axios = require('axios');

const SID    = process.env.COUPANG_COOKIE_SID;
const CT_AT  = process.env.COUPANG_COOKIE_CT_AT;
const AFATK  = process.env.COUPANG_COOKIE_AFATK;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

const BASE    = 'https://partners.coupang.com';
const POLL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 42;

// ─── 공통 헤더 ────────────────────────────────────────────────────────────────
function makeHeaders() {
    const cookie = [
        `sid=${SID}`,
        `CT_AT=${CT_AT}`,
        `AFATK=${AFATK}`,
    ].join('; ');

    return {
        'Content-Type': 'application/json',
        'Cookie': cookie,
        'Origin': BASE,
        'Referer': `${BASE}/`,
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36',
    };
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
function dateFilter(date) {
    return [
        { column: 'startDate', operator: 'EQUAL', value: [date] },
        { column: 'endDate',   operator: 'EQUAL', value: [date] },
    ];
}

async function fetchSummary(date) {
    const res = await axios.post(
        `${BASE}/api/v1/performance/summary`,
        { filters: dateFilter(date) },
        { headers: makeHeaders(), timeout: 15000 }
    );
    return res.data;
}

async function fetchProducts(date) {
    const PAGE_SIZE = 100;
    const allRows   = [];
    let pageNumber  = 0;
    let totalItems  = null;

    while (true) {
        const res = await axios.post(
            `${BASE}/api/v1/performance/product`,
            { filters: dateFilter(date), page: { size: PAGE_SIZE, pageNumber }, sorts: [] },
            { headers: makeHeaders(), timeout: 15000 }
        );

        const rows = res.data?.data?.content || [];
        if (!rows.length) break;
        allRows.push(...rows);

        if (totalItems === null) totalItems = res.data?.data?.total ?? rows.length;
        if (allRows.length >= totalItems) break;
        pageNumber++;
    }

    return allRows;
}

// ─── 카테고리 추론 ────────────────────────────────────────────────────────────
const CATEGORIES = [
    { keys: ['가전','냉장','세탁','청소','에어컨','제습','공기청정','건조기'], emoji: '🏠', label: '가전' },
    { keys: ['휴대폰','스마트폰','갤럭시','아이폰','태블릿','노트북','모니터','이어폰','카메라','전자'], emoji: '💻', label: '전자제품' },
    { keys: ['식빵','빵','쌀','김치','간장','된장','참치','사과','토마토','이유식','삼다수','음료','과자','라면','두부','식품'], emoji: '🍱', label: '식품' },
    { keys: ['강아지','고양이','펫','반려','사료','모래','급여기','드라이룸'], emoji: '🐾', label: '반려동물' },
    { keys: ['스킨','로션','크림','클렌징','세럼','마스크','선크림','화장','뷰티'], emoji: '💄', label: '뷰티' },
    { keys: ['비타민','콜라겐','멜라토닌','유산균','오메가','홍삼','영양제','건강'], emoji: '💊', label: '건강식품' },
    { keys: ['티셔츠','바지','원피스','재킷','코트','운동화','신발','속옷','브라','의류'], emoji: '👗', label: '패션/의류' },
    { keys: ['도서','수학','영어','문제집','참고서','소설','만화','책'], emoji: '📚', label: '도서' },
    { keys: ['장난감','포켓몬','레고','보드게임','완구','피규어'], emoji: '🎮', label: '취미/완구' },
    { keys: ['세제','칫솔','치약','샴푸','바디워시','수건','주방','생활'], emoji: '🧴', label: '생활용품' },
];

// API가 category 문자열을 직접 제공 → 이모지 매핑
const CAT_EMOJI_MAP = {
    '식품': '🍱', '로켓프레시': '🥦', '생활용품': '🧴', '가전': '🏠',
    '전자제품': '💻', '뷰티': '💄', '건강식품': '💊', '패션의류': '👗',
    '스포츠': '⚽', '반려동물': '🐾', '도서': '📚', '완구': '🎮',
    '주방': '🍳', '자동차': '🚗', '여행': '✈️',
};

function categoryEmoji(cat) {
    for (const [key, emoji] of Object.entries(CAT_EMOJI_MAP)) {
        if (cat.includes(key)) return emoji;
    }
    return '🛍️';
}

function guessCategory(name) {
    for (const cat of CATEGORIES) {
        if (cat.keys.some(k => name.includes(k))) return cat;
    }
    return { emoji: '🛍️', label: '기타' };
}

// ─── 파싱 ────────────────────────────────────────────────────────────────────
function parseProducts(rows) {
    const productMap  = {};
    const categoryMap = {};

    for (const row of rows) {
        const rev    = Number(row.commission || 0);
        const sale   = Number(row.gmv        || 0);
        const qty    = Number(row.quantity   || 0);
        const pName  = row.product    || '(상품명 없음)';
        const pId    = String(row.productId || pName);
        const cat    = row.category   ? { emoji: categoryEmoji(row.category), label: row.category }
                                      : guessCategory(pName);

        if (!productMap[pId])          productMap[pId]          = { name: pName, revenue: 0, qty: 0 };
        productMap[pId].revenue       += rev;
        productMap[pId].qty           += qty;

        if (!categoryMap[cat.label])   categoryMap[cat.label]   = { emoji: cat.emoji, revenue: 0, orders: 0 };
        categoryMap[cat.label].revenue += rev;
        categoryMap[cat.label].orders  += qty;
    }

    return {
        top5: Object.values(productMap).sort((a, b) => b.revenue - a.revenue).slice(0, 5),
        categoryLines: Object.entries(categoryMap)
            .sort(([, a], [, b]) => b.revenue - a.revenue)
            .map(([label, v]) => `${v.emoji} ${label}  ₩${fmt(v.revenue)} (${v.orders}건)`),
    };
}

function parseSummary(data) {
    const d = data?.data || data;
    return {
        revenue  : Number(d?.commission  || 0),
        sales    : Number(d?.gmv         || 0),
        orders   : Number(d?.orderCount  || 0),
        clicks   : Number(d?.clickCount  || 0),
        convRate : d?.conversion != null ? (d.conversion * 100).toFixed(2) : null,
    };
}

// ─── 메시지 포맷 ──────────────────────────────────────────────────────────────
function buildMessage(date, sum, prod) {
    const convRate = sum.convRate != null ? `${sum.convRate}%`
        : (sum.clicks > 0 ? `${((sum.orders / sum.clicks) * 100).toFixed(2)}%` : '-');

    const L = [
        `📊 <b>쿠팡파트너스 일일 리포트</b>`,
        `📅 ${date} (어제)`,
        ``,
        `💰 수익:     <b>₩${fmt(sum.revenue)}</b>`,
        `🛒 구매건수: ${fmt(sum.orders)}건`,
        `💳 합산매출: ₩${fmt(sum.sales)}`,
        `👆 클릭수:   ${fmt(sum.clicks)}`,
        `📈 전환율:   ${convRate}`,
    ];

    if (prod.top5.length > 0) {
        L.push(``, `─────────────────────`, `🏆 TOP ${prod.top5.length} 상품`);
        prod.top5.forEach((p, i) => {
            const name = p.name.length > 16 ? p.name.slice(0, 15) + '…' : p.name;
            L.push(`${i + 1}. ${name}  ₩${fmt(p.revenue)}`);
        });
    }

    if (prod.categoryLines.length > 0) {
        L.push(``, `─────────────────────`, `📂 카테고리별 수익`);
        L.push(...prod.categoryLines.slice(0, 10));
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
    } catch {}
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
    if (!SID || !CT_AT || !AFATK) {
        console.error('❌ .env에 COUPANG_COOKIE_SID / CT_AT / AFATK 없음');
        console.error('   Chrome → F12 → Application → Cookies → partners.coupang.com 에서 복사');
        process.exit(1);
    }

    const args    = process.argv.slice(2);
    const isTest  = args.includes('--test');
    const dateIdx = args.indexOf('--date');
    const date    = dateIdx >= 0 ? args[dateIdx + 1] : getYesterdayKST();

    console.log(`[쿠팡 리포트] 대상 날짜: ${date}`);
    await clearCommands();

    if (isTest) {
        console.log('\n[TEST] summary 응답:');
        try { console.log(JSON.stringify(await fetchSummary(date), null, 2)); }
        catch (e) { console.error('summary 실패:', e.response?.data || e.message); }

        console.log('\n[TEST] product 응답 (1페이지):');
        try {
            const res = await axios.post(
                `${BASE}/api/v1/performance/product`,
                { filters: dateFilter(date), page: { size: 5, pageNumber: 0 }, sorts: [] },
                { headers: makeHeaders(), timeout: 15000 }
            );
            console.log(JSON.stringify(res.data, null, 2));
        } catch (e) { console.error('product 실패:', e.response?.data || e.message); }
        return;
    }

    // ─── 폴링 루프 ──────────────────────────────────────────────────────────
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const t = new Date(Date.now() + 9 * 3600000).toISOString().slice(11, 16);
        console.log(`[${t} KST] 시도 ${attempt}/${MAX_ATTEMPTS}...`);

        try {
            const summaryRaw = await fetchSummary(date);
            const sum = parseSummary(summaryRaw);
            console.log(`   📊 수익:₩${fmt(sum.revenue)} 건수:${sum.orders} 매출:₩${fmt(sum.sales)} 클릭:${sum.clicks}`);

            const done = sum.revenue > 0 && sum.orders > 0 && sum.sales > 0;
            if (!done) {
                console.log('   ⏳ 집계 중. 10분 후 재시도...');
            } else {
                console.log('   📦 상품 데이터 수집 중...');
                const productRows = await fetchProducts(date);
                console.log(`   ✅ ${productRows.length}개 상품 수집 완료`);
                const prod = parseProducts(productRows);
                await sendTelegram(buildMessage(date, sum, prod));
                break;
            }
        } catch (err) {
            const msg = err.response?.status === 401
                ? '401 인증 만료 — .env 쿠키 갱신 필요'
                : (err.response?.data ? JSON.stringify(err.response.data) : err.message);
            console.error(`   ❌ ${msg}`);
        }

        if (attempt < MAX_ATTEMPTS) {
            await new Promise(r => setTimeout(r, POLL_MS));
        } else {
            await sendTelegram(`⚠️ <b>쿠팡 리포트 조회 실패</b>\n📅 ${date}\n🕐 ${nowKST()}`);
        }
    }
}

main().catch(e => { console.error('오류:', e.message); process.exit(1); });
