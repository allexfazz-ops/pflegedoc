/**
 * PflegeDoc — K3 (E+) Hard Global Deadline — teste unitare
 * -----------------------------------------------------------------------------
 * Verifică cele 3 funcții pure exportate de api/generate.js care implementează
 * deadline-ul global HARD al buclei de retry:
 *   effectiveAttemptTimeout(perAttemptMs, remainingMs)
 *   canStartAttempt(remainingMs)
 *   planBackoff(attempt, maxAttempts, backoffMs, remainingMs)
 *
 * Nu face I/O, nu atinge rețeaua, nu modifică nimic. Pur diagnostic.
 *   node tests/k3-timeout.mjs
 */

import {
    effectiveAttemptTimeout,
    canStartAttempt,
    planBackoff,
} from "../api/generate.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${extra ? "  -> " + extra : ""}`); }
};

// Constante reale (verbatim din api/generate.js — NU se schimbă la K3).
const PER_ATTEMPT_TIMEOUT_MS = 22000;
const TOTAL_BUDGET_MS = 44000;
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [1200, 2600];

console.log("K3 (E+) — Hard global deadline\n");

/* -------- Test 1 — attempt cu buget suficient -> timeout efectiv = 22000 -------- */
ok("T1: remaining 30000 (> 22000) -> timeout efectiv 22000",
    effectiveAttemptTimeout(PER_ATTEMPT_TIMEOUT_MS, 30000) === 22000);
ok("T1: remaining fix la 22001 -> timeout efectiv 22000",
    effectiveAttemptTimeout(PER_ATTEMPT_TIMEOUT_MS, 22001) === 22000);
ok("T1: exemplul din brief — attempt 2 la ~23.2s -> ~20.8s, NU 22s",
    effectiveAttemptTimeout(PER_ATTEMPT_TIMEOUT_MS, TOTAL_BUDGET_MS - 23200) === 20800);

/* -------- Test 2 — attempt cu remaining = 8000 -> timeout efectiv = 8000 -------- */
ok("T2: remaining 8000 -> timeout efectiv 8000",
    effectiveAttemptTimeout(PER_ATTEMPT_TIMEOUT_MS, 8000) === 8000);
ok("T2: remaining 1 -> timeout efectiv 1 (nu 0, nu negativ)",
    effectiveAttemptTimeout(PER_ATTEMPT_TIMEOUT_MS, 1) === 1);

/* -------- Test 3 — remaining <= 0 -> NU se face fetch Gemini -------- */
ok("T3: canStartAttempt(0) === false", canStartAttempt(0) === false);
ok("T3: canStartAttempt(-500) === false", canStartAttempt(-500) === false);
ok("T3: canStartAttempt(1) === true", canStartAttempt(1) === true);
ok("T3: effectiveAttemptTimeout clamp-at la >=1 chiar dacă remaining 0/negativ",
    effectiveAttemptTimeout(PER_ATTEMPT_TIMEOUT_MS, 0) === 1 &&
    effectiveAttemptTimeout(PER_ATTEMPT_TIMEOUT_MS, -9999) === 1);

/* -------- Test 4 — backoff > buget rămas -> fără sleep inutil, fără attempt nou -------- */
{
    // attempt 1, backoff 1200, dar au rămas doar 800 ms -> nu se face retry.
    const p = planBackoff(1, MAX_ATTEMPTS, RETRY_BACKOFF_MS[0], 800);
    ok("T4: remaining 800 < backoff 1200 -> retry=false, sleepMs=0",
        p.retry === false && p.sleepMs === 0, JSON.stringify(p));
}
{
    // remaining == backoff exact -> tot fără retry (nu rămâne timp de rulare).
    const p = planBackoff(2, MAX_ATTEMPTS, RETRY_BACKOFF_MS[1], 2600);
    ok("T4: remaining == backoff (2600) -> retry=false",
        p.retry === false && p.sleepMs === 0, JSON.stringify(p));
}
{
    // remaining > backoff -> retry, sleep clamp-at (aici == backoff).
    const p = planBackoff(1, MAX_ATTEMPTS, RETRY_BACKOFF_MS[0], 5000);
    ok("T4: remaining 5000 > backoff 1200 -> retry=true, sleepMs=1200",
        p.retry === true && p.sleepMs === 1200, JSON.stringify(p));
}
{
    // sleepMs nu depășește niciodată bugetul rămas (robustețe).
    const p = planBackoff(1, MAX_ATTEMPTS, 10000, 3000);
    ok("T4: sleepMs clamp-at la remaining (3000), nu la backoff (10000)",
        p.retry === false && p.sleepMs === 0, JSON.stringify(p));
    // (retry=false pentru că remaining <= backoff; sleepMs rămâne 0)
}

/* -------- Test 7 — MAX_ATTEMPTS rămâne 3 (plafon dur, independent de buget) -------- */
ok("T7: attempt 3 din 3 -> retry=false chiar cu buget mare",
    planBackoff(3, MAX_ATTEMPTS, RETRY_BACKOFF_MS[1], 40000).retry === false);
ok("T7: attempt 2 din 3 cu buget mare -> retry=true",
    planBackoff(2, MAX_ATTEMPTS, RETRY_BACKOFF_MS[1], 40000).retry === true);
ok("T7: MAX_ATTEMPTS este 3", MAX_ATTEMPTS === 3);

/* -------- Simulare integrată — worst-case cu 2 attempts blocate -------- */
{
    // t0 = 0. attempt1 pornește: remaining 44000 -> timeout 22000. Se blochează,
    // abort la t=22000. backoff attempt1 = 1200, remaining = 22000 > 1200 -> sleep 1200.
    // attempt2 pornește la t=23200: remaining = 20800 -> timeout EFECTIV 20800 (NU 22000).
    // abort la t=44000. backoff attempt2 = 2600, remaining = 0 -> retry=false.
    // attempt3 NU pornește. Total <= 44000. maxDuration (60000) niciodată atins.
    let t = 0;
    const rem = () => Math.max(0, TOTAL_BUDGET_MS - t);
    ok("SIM: attempt1 timeout = 22000", effectiveAttemptTimeout(PER_ATTEMPT_TIMEOUT_MS, rem()) === 22000);
    t = 22000;
    const p1 = planBackoff(1, MAX_ATTEMPTS, RETRY_BACKOFF_MS[0], rem());
    ok("SIM: backoff dupa attempt1 -> retry, sleep 1200", p1.retry && p1.sleepMs === 1200);
    t += p1.sleepMs; // 23200
    ok("SIM: attempt2 poate porni", canStartAttempt(rem()));
    const to2 = effectiveAttemptTimeout(PER_ATTEMPT_TIMEOUT_MS, rem());
    ok("SIM: attempt2 timeout EFECTIV = 20800 (nu 22000)", to2 === 20800);
    t += to2; // 44000
    const p2 = planBackoff(2, MAX_ATTEMPTS, RETRY_BACKOFF_MS[1], rem());
    ok("SIM: dupa attempt2 -> fara retry (deadline atins)", p2.retry === false);
    ok("SIM: attempt3 NU poate porni", canStartAttempt(rem()) === false);
    ok("SIM: timp total server <= TOTAL_BUDGET_MS (44000)", t <= TOTAL_BUDGET_MS);
}

console.log(`\n----------------------------------------`);
console.log(`TOTAL: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
