import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

// ======================================================
// SOLANA PAPER TRADING BOT V1
// Scanner → Filter → Paper BUY → Monitor → TP / SL
// BELUM ADA TRANSAKSI UANG ASLI
// ======================================================

const API = "https://api.dexscreener.com";

const CONFIG = {
  chain: "solana",

  // Modal simulasi
  startingBalance: 100,

  // Maksimal modal untuk 1 token
  tradeAmount: 5,

  // Maksimal posisi bersamaan
  maxPositions: 3,

  // Target profit dan stop loss
  takeProfit: 0.15, // +15%
  stopLoss: -0.08,   // -8%

  // Token harus relatif baru
  maxPairAgeMinutes: 60,

  // Filter minimum
  minLiquidityUsd: 15000,
  minVolume5mUsd: 1000,
  minTxns5m: 5,

  // Bot melakukan scan setiap 20 detik
  scanIntervalMs: 20000
};

let balance = CONFIG.startingBalance;
let positions = new Map();
let seenTokens = new Set();

let scanning = false;

// ======================================================
// UTILITIES
// ======================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function money(value) {
  return `$${Number(value).toFixed(2)}`;
}

function percent(value) {
  return `${(value * 100).toFixed(2)}%`;
}

function pairAgeMinutes(pair) {
  if (!pair.pairCreatedAt) return Infinity;

  const created = Number(pair.pairCreatedAt);
  const now = Date.now();

  return (now - created) / 60000;
}

function get5mTxns(pair) {
  return pair.txns?.m5 || { buys: 0, sells: 0 };
}

function get5mVolume(pair) {
  return Number(pair.volume?.m5 || 0);
}

function getLiquidity(pair) {
  return Number(pair.liquidity?.usd || 0);
}

function getPrice(pair) {
  return Number(pair.priceUsd || 0);
}

// ======================================================
// TELEGRAM
// ======================================================

async function sendTelegram(message) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) {
    return;
  }

  try {
    await axios.post(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        chat_id: chatId,
        text: message
      }
    );
  } catch (error) {
    console.log("Telegram error:", error.message);
  }
}

// ======================================================
// GET LATEST TOKEN PROFILES
// ======================================================

async function getLatestTokens() {
  try {
    const response = await axios.get(
      `${API}/token-profiles/latest/v1`,
      {
        timeout: 10000
      }
    );

    const data = response.data;

    if (!Array.isArray(data)) {
      return [];
    }

    return data.filter(
      token => token.chainId === CONFIG.chain
    );

  } catch (error) {
    console.log(
      "Gagal mengambil token terbaru:",
      error.message
    );

    return [];
  }
}

// ======================================================
// GET PAIRS FOR TOKENS
// ======================================================

async function getTokenPairs(addresses) {
  if (addresses.length === 0) {
    return [];
  }

  try {
    const url =
      `${API}/tokens/v1/${CONFIG.chain}/${addresses.join(",")}`;

    const response = await axios.get(url, {
      timeout: 10000
    });

    return Array.isArray(response.data)
      ? response.data
      : [];

  } catch (error) {
    console.log(
      "Gagal mengambil pair:",
      error.message
    );

    return [];
  }
}

// ======================================================
// SCORE TOKEN
// ======================================================

function calculateScore(pair) {
  let score = 0;

  const age = pairAgeMinutes(pair);
  const liquidity = getLiquidity(pair);
  const volume5m = get5mVolume(pair);
  const txns = get5mTxns(pair);

  const buys = Number(txns.buys || 0);
  const sells = Number(txns.sells || 0);

  // Pair sangat baru
  if (age <= 10) {
    score += 20;
  } else if (age <= 30) {
    score += 15;
  } else if (age <= 60) {
    score += 10;
  }

  // Liquidity
  if (liquidity >= 100000) {
    score += 20;
  } else if (liquidity >= 50000) {
    score += 15;
  } else if (liquidity >= 15000) {
    score += 10;
  }

  // Volume
  if (volume5m >= 50000) {
    score += 20;
  } else if (volume5m >= 10000) {
    score += 15;
  } else if (volume5m >= 1000) {
    score += 10;
  }

  // Aktivitas transaksi
  if (buys >= 30) {
    score += 15;
  } else if (buys >= 10) {
    score += 10;
  } else if (buys >= 5) {
    score += 5;
  }

  // Tekanan beli
  if (buys > sells * 3) {
    score += 15;
  } else if (buys > sells) {
    score += 10;
  }

  return score;
}

// ======================================================
// FILTER TOKEN
// ======================================================

function qualifies(pair) {
  if (!pair) return false;

  if (pair.chainId !== CONFIG.chain) {
    return false;
  }

  const price = getPrice(pair);
  const liquidity = getLiquidity(pair);
  const volume5m = get5mVolume(pair);
  const txns = get5mTxns(pair);

  const buys = Number(txns.buys || 0);
  const sells = Number(txns.sells || 0);

  const age = pairAgeMinutes(pair);

  if (!price || price <= 0) {
    return false;
  }

  if (age > CONFIG.maxPairAgeMinutes) {
    return false;
  }

  if (liquidity < CONFIG.minLiquidityUsd) {
    return false;
  }

  if (volume5m < CONFIG.minVolume5mUsd) {
    return false;
  }

  if ((buys + sells) < CONFIG.minTxns5m) {
    return false;
  }

  if (buys <= sells) {
    return false;
  }

  return true;
}

// ======================================================
// PAPER BUY
// ======================================================

async function paperBuy(pair, score) {
  const tokenAddress = pair.baseToken?.address;
  const symbol = pair.baseToken?.symbol || "UNKNOWN";
  const price = getPrice(pair);

  if (!tokenAddress || !price) {
    return;
  }

  if (positions.has(tokenAddress)) {
    return;
  }

  if (positions.size >= CONFIG.maxPositions) {
    return;
  }

  if (balance < CONFIG.tradeAmount) {
    console.log("Saldo simulasi tidak cukup.");
    return;
  }

  const amountUsd = CONFIG.tradeAmount;
  const tokenAmount = amountUsd / price;

  balance -= amountUsd;

  const position = {
    tokenAddress,
    symbol,
    pairAddress: pair.pairAddress,
    entryPrice: price,
    tokenAmount,
    invested: amountUsd,
    score,
    openedAt: Date.now()
  };

  positions.set(tokenAddress, position);

  console.log("");
  console.log("======================================");
  console.log("PAPER BUY");
  console.log("======================================");
  console.log("Token       :", symbol);
  console.log("Entry       :", money(price));
  console.log("Investment  :", money(amountUsd));
  console.log("Token       :", tokenAmount);
  console.log("Score       :", score);
  console.log("Balance     :", money(balance));
  console.log("======================================");

  await sendTelegram(
    `PAPER BUY\n\n` +
    `Token: ${symbol}\n` +
    `Entry: ${money(price)}\n` +
    `Modal: ${money(amountUsd)}\n` +
    `Score: ${score}\n` +
    `TP: +${CONFIG.takeProfit * 100}%\n` +
    `SL: ${CONFIG.stopLoss * 100}%`
  );
}

// ======================================================
// PAPER SELL
// ======================================================

async function paperSell(position, currentPrice, reason) {
  const exitValue =
    position.tokenAmount * currentPrice;

  const pnl =
    exitValue - position.invested;

  balance += exitValue;

  positions.delete(position.tokenAddress);

  const pnlPercent =
    pnl / position.invested;

  console.log("");
  console.log("======================================");
  console.log("PAPER SELL");
  console.log("======================================");
  console.log("Token       :", position.symbol);
  console.log("Entry       :", money(position.entryPrice));
  console.log("Exit        :", money(currentPrice));
  console.log("Result      :", reason);
  console.log("PnL         :", money(pnl));
  console.log("PnL %       :", percent(pnlPercent));
  console.log("Balance     :", money(balance));
  console.log("======================================");

  await sendTelegram(
    `PAPER SELL\n\n` +
    `Token: ${position.symbol}\n` +
    `Entry: ${money(position.entryPrice)}\n` +
    `Exit: ${money(currentPrice)}\n` +
    `Result: ${reason}\n` +
    `PnL: ${money(pnl)} (${percent(pnlPercent)})\n` +
    `Balance: ${money(balance)}`
  );
}

// ======================================================
// MONITOR OPEN POSITIONS
// ======================================================

async function monitorPositions() {
  if (positions.size === 0) {
    return;
  }

  for (const position of positions.values()) {
    try {
      const pairs =
        await getTokenPairs([
          position.tokenAddress
        ]);

      if (!pairs.length) {
        continue;
      }

      // Cari pair dengan liquidity terbesar
      const pair = pairs
        .filter(p => p.chainId === CONFIG.chain)
        .sort(
          (a, b) =>
            getLiquidity(b) - getLiquidity(a)
        )[0];

      if (!pair) {
        continue;
      }

      const currentPrice =
        getPrice(pair);

      if (!currentPrice) {
        continue;
      }

      const change =
        (currentPrice - position.entryPrice) /
        position.entryPrice;

      console.log(
        `[MONITOR] ${position.symbol} | ` +
        `Entry ${money(position.entryPrice)} | ` +
        `Now ${money(currentPrice)} | ` +
        `PnL ${percent(change)}`
      );

      // TAKE PROFIT
      if (change >= CONFIG.takeProfit) {
        await paperSell(
          position,
          currentPrice,
          "TAKE PROFIT"
        );

        continue;
      }

      // STOP LOSS
      if (change <= CONFIG.stopLoss) {
        await paperSell(
          position,
          currentPrice,
          "STOP LOSS"
        );
      }

    } catch (error) {
      console.log(
        `Monitor ${position.symbol}:`,
        error.message
      );
    }
  }
}

// ======================================================
// SCANNER
// ======================================================

async function scan() {
  if (scanning) {
    return;
  }

  scanning = true;

  try {
    console.log("");
    console.log("======================================");
    console.log(
      "SCAN",
      new Date().toLocaleString("id-ID")
    );
    console.log("======================================");

    const latestTokens =
      await getLatestTokens();

    if (!latestTokens.length) {
      console.log(
        "Tidak ada token terbaru yang ditemukan."
      );

      return;
    }

    const addresses = latestTokens
      .map(t => t.tokenAddress)
      .filter(Boolean)
      .filter(
        address => !seenTokens.has(address)
      )
      .slice(0, 30);

    if (!addresses.length) {
      console.log(
        "Belum ada token baru dari scan terakhir."
      );

      return;
    }

    const pairs =
      await getTokenPairs(addresses);

    console.log(
      `Mendapatkan ${pairs.length} pair Solana.`
    );

    const candidates = [];

    for (const pair of pairs) {
      const address =
        pair.baseToken?.address;

      if (!address) {
        continue;
      }

      seenTokens.add(address);

      if (!qualifies(pair)) {
        continue;
      }

      const score =
        calculateScore(pair);

      candidates.push({
        pair,
        score
      });
    }

    candidates.sort(
      (a, b) => b.score - a.score
    );

    if (!candidates.length) {
      console.log(
        "Belum ada token yang memenuhi filter."
      );

      return;
    }

    console.log(
      `Kandidat ditemukan: ${candidates.length}`
    );

    for (const candidate of candidates.slice(0, 5)) {
      const pair = candidate.pair;

      console.log("");
      console.log(
        `CANDIDATE: ${pair.baseToken.symbol}`
      );

      console.log(
        "Price     :",
        money(getPrice(pair))
      );

      console.log(
        "Liquidity :",
        money(getLiquidity(pair))
      );

      console.log(
        "Volume 5m :",
        money(get5mVolume(pair))
      );

      console.log(
        "Age       :",
        pairAgeMinutes(pair).toFixed(1),
        "menit"
      );

      console.log(
        "Buys/Sells:",
        get5mTxns(pair).buys,
        "/",
        get5mTxns(pair).sells
      );

      console.log(
        "Score     :",
        candidate.score
      );
    }

    // Ambil kandidat terbaik
    const best = candidates[0];

    // Hanya paper BUY jika score cukup tinggi
    if (best.score >= 60) {
      await paperBuy(
        best.pair,
        best.score
      );
    }

  } catch (error) {
    console.log(
      "Scanner error:",
      error.message
    );
  } finally {
    scanning = false;
  }
}

// ======================================================
// START BOT
// ======================================================

console.log("");
console.log("======================================");
console.log(" SOLANA PAPER TRADING BOT V1");
console.log("======================================");
console.log("Mode       : PAPER TRADING");
console.log("Modal      :", money(balance));
console.log("Trade      :", money(CONFIG.tradeAmount));
console.log("TP         :", `+${CONFIG.takeProfit * 100}%`);
console.log("SL         :", `${CONFIG.stopLoss * 100}%`);
console.log("Max Posisi :", CONFIG.maxPositions);
console.log("======================================");
console.log("");

async function main() {
  await scan();
  await monitorPositions();

  setInterval(async () => {
    await scan();
    await monitorPositions();
  }, CONFIG.scanIntervalMs);
}

main();
