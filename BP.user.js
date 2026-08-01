// ==UserScript==
// @name         MTurk Human-Like Rater (Version 28.0 - Multi-Layer Stealth)
// @namespace    http://tampermonkey.net/
// @version      28.1
// @description  Photo-specific comments, no default notes, slow typing, full anti-detection
// @author       You
// @match        *://worker.mturk.com/*
// @match        *://*.photofeeler.com/*
// @match        *://*.mturkcontent.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      photos.benpeterson.info
// @connect      generativelanguage.googleapis.com
// ==/UserScript==

(function() {
    'use strict';

    // ==========================================
    // সেকশন ০: Background Tab Fix + Visibility
    // ==========================================
    const nativeHiddenGetter = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden')?.get
                            || Object.getOwnPropertyDescriptor(HTMLDocument.prototype, 'hidden')?.get;

    function isTabReallyHidden() {
        if (nativeHiddenGetter) return nativeHiddenGetter.call(document);
        return !document.hasFocus();
    }

    Object.defineProperty(document, 'hidden', { configurable: true, get: function() { return false; } });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: function() { return 'visible'; } });
    window.addEventListener('visibilitychange', e => e.stopPropagation(), true);

    const currentUrl = window.location.href;

    let API_KEY = GM_getValue('gemini_api_key', '');

    GM_registerMenuCommand('Change Gemini API Key', () => {
        const newKey = prompt('Enter new Gemini API Key:', API_KEY);
        if (newKey && newKey.trim() !== '') {
            GM_setValue('gemini_api_key', newKey.trim());
            alert('API Key updated! Reloading page...');
            location.reload();
        }
    });

    if (!API_KEY || API_KEY.trim() === '') {
        API_KEY = prompt('🔑 First time setup: Enter your Gemini API Key\n(Get one from aistudio.google.com)');
        if (API_KEY && API_KEY.trim() !== '') {
            GM_setValue('gemini_api_key', API_KEY.trim());
        } else {
            console.error('No API Key provided. Script will not work.');
            return;
        }
    }

    // ==========================================
    // সেকশন ১: সুপার অটো-ক্লোজ লজিক
    // ==========================================
    let isSuccessPage = sessionStorage.getItem('ben_just_submitted') === 'true';

    if (document.body && (document.body.textContent.includes("The HIT has been successfully submitted") || document.body.textContent.includes("HIT Submitted"))) {
        isSuccessPage = true;
    }

    if (isSuccessPage) {
        console.log("✅ Work submitted successfully! Auto-closing tab...");
        sessionStorage.removeItem('ben_just_submitted');
        window.close();
        setTimeout(() => window.close(), 1000);
        return;
    }

    window.addEventListener('load', () => {
        if (document.body && (document.body.textContent.includes("The HIT has been successfully submitted") || document.body.textContent.includes("HIT Submitted"))) {
            sessionStorage.removeItem('ben_just_submitted');
            window.close();
        }
    });

    // ==========================================
    // সেকশন ২: অটো-ওপেনার লজিক
    // ==========================================
    if (currentUrl.includes("worker.mturk.com/tasks") && !currentUrl.includes("/projects/")) {
        setInterval(() => {
            let openedHITs;
            try {
                openedHITs = JSON.parse(sessionStorage.getItem('ben_opened_hits') || '[]');
            } catch (e) {
                openedHITs = [];
            }
            const rows = document.querySelectorAll('.table-row, tr');

            rows.forEach(row => {
                if (row.textContent.includes('Ben Peterson')) {
                    const workBtn = row.querySelector('a[href*="/tasks/"]');
                    if (workBtn && workBtn.textContent.includes('Work') && !openedHITs.includes(workBtn.href)) {
                        openedHITs.push(workBtn.href);
                        if (openedHITs.length > 50) openedHITs.shift();
                        sessionStorage.setItem('ben_opened_hits', JSON.stringify(openedHITs));
                        GM_openInTab(workBtn.href, { active: false, insert: true });
                    }
                }
            });
        }, 2000);
        return;
    }

    // ==========================================
    // সেকশন ৩: রেটিং, UI ড্যাশবোর্ড এবং লজিক
    // ==========================================
    if (currentUrl.includes("photofeeler.com") || currentUrl.includes("mturkcontent.com") || document.querySelector('img:not([src*=".svg"])')) {

        const MODELS_TO_TEST = ["gemini-3.1-flash-lite", "gemini-3.5-flash"];

        // --- Worker Personality System ---
        // প্রতিটা MTurk worker ID-র জন্য unique "personality" তৈরি করে store করে
        // এতে cross-account correlation ধরা যায় না
        function getWorkerPersonality() {
            const workerIdEl = document.querySelector('[data-worker-id], .worker-id');
            const tabId = sessionStorage.getItem('ben_tab_id') || (Math.random().toString(36).slice(2, 10));
            sessionStorage.setItem('ben_tab_id', tabId);
            const personalityKey = 'ben_personality_' + tabId;

            let personality = GM_getValue(personalityKey, null);
            if (personality) {
                try { return JSON.parse(personality); } catch(e) {}
            }

            const seed = Math.random;
            personality = {
                ratingBias: { smart: (seed() - 0.5) * 0.5, trustworthy: (seed() - 0.5) * 0.5, attractive: (seed() - 0.5) * 0.5 },
                speedProfile: ['slow', 'medium', 'fast'][Math.floor(seed() * 3)],
                speedMultiplier: 0.7 + seed() * 1.1,
                correctionRate: 0.03 + seed() * 0.12,
                distractionRate: 0.02 + seed() * 0.06,
                noteStyle: ['minimal', 'short', 'medium'][Math.floor(seed() * 3)],
                noteRate: 0.15 + seed() * 0.13,
                harshness: -0.25 + seed() * 0.4,
                traitOrder: seed() < 0.15 ? 'shuffled' : 'normal',
                skipRate: 0.005 + seed() * 0.025,
                opinions: {
                    shirtlessSmartPenalty: seed() < 0.6,
                    shirtlessTrustPenalty: seed() < 0.5,
                    glassesSmartBonus: seed() < 0.55,
                    smileTrustBonus: seed() < 0.7,
                    sunglassesTrustPenalty: seed() < 0.6,
                    hatSmartPenalty: seed() < 0.35,
                    professionalAttireSmartBonus: seed() < 0.5,
                    outdoorAttractBonus: seed() < 0.3,
                    grumpyExpressionTrustPenalty: seed() < 0.5,
                    biasStrength: 0.6 + seed() * 0.7
                },
                voice: {
                    usesExclamation: seed() < 0.2,
                    lowercaseOnly: seed() < 0.55,
                    contractions: seed() < 0.4,
                    slang: seed() < 0.3,
                    critical: seed() < 0.4
                },
                created: Date.now()
            };

            GM_setValue(personalityKey, JSON.stringify(personality));
            return personality;
        }

        const personality = getWorkerPersonality();

        function logNormalDelay(median, sigma) {
            const u1 = Math.random();
            const u2 = Math.random();
            const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
            return Math.floor(Math.max(median * 0.3, median * Math.exp(sigma * z)));
        }

        function applyRatingNoise(score, traitBias, extraBias = 0) {
            const combined = traitBias + personality.harshness + extraBias;
            let noised = score;

            if (Math.random() < Math.abs(combined) * 0.35) {
                noised += combined > 0 ? 1 : -1;
            }

            return Math.max(0, Math.min(3, Math.round(noised)));
        }

        // Fast string hash for photo URL identity
        function hashStr(s) {
            let h = 0;
            for (let i = 0; i < s.length; i++) {
                h = ((h << 5) - h) + s.charCodeAt(i);
                h |= 0;
            }
            return h.toString(36);
        }

        function extractPhotoId(url) {
            const m = url && url.match(/([a-f0-9\-]{8,})(?:\.[a-z]+)?(?:\?.*)?$/i);
            return m ? m[1] : hashStr(url || '');
        }

        // Per-photo memory: remember what we rated for the same photo
        function getPhotoMemory() {
            try { return JSON.parse(GM_getValue('ben_photo_memory', '{}')); } catch (e) { return {}; }
        }
        function savePhotoMemory(mem) {
            const keys = Object.keys(mem);
            if (keys.length > 800) {
                const sorted = keys.sort((a, b) => (mem[a].t || 0) - (mem[b].t || 0));
                for (let i = 0; i < keys.length - 800; i++) delete mem[sorted[i]];
            }
            GM_setValue('ben_photo_memory', JSON.stringify(mem));
        }

        // Session-wide score distribution — nudge toward realistic spread
        function getSessionDist() {
            try { return JSON.parse(sessionStorage.getItem('ben_score_dist') || '{"0":0,"1":0,"2":0,"3":0}'); }
            catch(e) { return {"0":0,"1":0,"2":0,"3":0}; }
        }
        function saveSessionDist(d) { sessionStorage.setItem('ben_score_dist', JSON.stringify(d)); }
        function recordScore(s) {
            const d = getSessionDist();
            d[s] = (d[s] || 0) + 1;
            saveSessionDist(d);
        }
        // Target: 0≈15%, 1≈30%, 2≈35%, 3≈20% — realistic human distribution
        function computeAdaptiveHarshness() {
            const d = getSessionDist();
            const total = (d["0"]||0)+(d["1"]||0)+(d["2"]||0)+(d["3"]||0);
            if (total < 8) return 0;
            const avg = ((d["1"]||0)*1 + (d["2"]||0)*2 + (d["3"]||0)*3) / total;
            if (avg > 2.1) return -0.7;
            if (avg > 1.85) return -0.35;
            if (avg < 1.3) return 0.25;
            return 0;
        }
        function shouldForceLowScore() {
            const d = getSessionDist();
            const total = (d["0"]||0)+(d["1"]||0)+(d["2"]||0)+(d["3"]||0);
            if (total < 15) return false;
            const zeroPct = (d["0"]||0) / total;
            return zeroPct < 0.08 && Math.random() < 0.25;
        }
        function shouldSuppressHighScore() {
            const d = getSessionDist();
            const total = (d["0"]||0)+(d["1"]||0)+(d["2"]||0)+(d["3"]||0);
            if (total < 12) return false;
            const threePct = (d["3"]||0) / total;
            return threePct > 0.22;
        }

        // Cross-tab used-notes log to avoid same phrase across accounts
        function getUsedNotes() {
            try { return JSON.parse(GM_getValue('ben_used_notes', '[]')); } catch(e) { return []; }
        }
        function addUsedNote(note) {
            const list = getUsedNotes();
            list.push({ n: note.toLowerCase().trim(), t: Date.now() });
            const trimmed = list.slice(-300);
            GM_setValue('ben_used_notes', JSON.stringify(trimmed));
        }
        function isNoteRecentlyUsed(note) {
            const n = note.toLowerCase().trim();
            const list = getUsedNotes();
            const cutoff = Date.now() - 48 * 3600 * 1000;
            return list.some(e => e.n === n && e.t > cutoff);
        }

        // Apply per-personality opinion biases based on features AI reported
        function applyOpinionBias(features) {
            const bias = { smart: 0, trustworthy: 0, attractive: 0 };
            if (!features || typeof features !== 'object') return bias;
            const o = personality.opinions;
            const s = o.biasStrength;

            if (features.shirtless && o.shirtlessSmartPenalty) bias.smart -= 0.5 * s;
            if (features.shirtless && o.shirtlessTrustPenalty) bias.trustworthy -= 0.4 * s;
            if (features.glasses && o.glassesSmartBonus) bias.smart += 0.4 * s;
            if (features.smiling && o.smileTrustBonus) bias.trustworthy += 0.4 * s;
            if (features.sunglasses && o.sunglassesTrustPenalty) bias.trustworthy -= 0.5 * s;
            if (features.hat && o.hatSmartPenalty) bias.smart -= 0.25 * s;
            if (features.professional_attire && o.professionalAttireSmartBonus) bias.smart += 0.5 * s;
            if (features.outdoor && o.outdoorAttractBonus) bias.attractive += 0.3 * s;
            if (features.grumpy_expression && o.grumpyExpressionTrustPenalty) bias.trustworthy -= 0.5 * s;
            return bias;
        }

        // Adjust note to match personality voice
        function styleNote(note) {
            if (!note) return note;
            let n = note.trim();
            const v = personality.voice;
            if (v.lowercaseOnly) n = n.toLowerCase();
            if (v.usesExclamation && !n.endsWith('!') && !n.endsWith('.') && Math.random() < 0.4) n += '!';
            if (v.contractions) {
                n = n.replace(/\bit is\b/gi, "it's").replace(/\bdo not\b/gi, "don't").replace(/\bthat is\b/gi, "that's");
            }
            return n;
        }

        let currentPhotoUrl = null;

        // --- Session Fatigue: HIT বাড়লে delay বাড়ে ---
        const sessionStartTime = Date.now();
        let sessionHITsDone = parseInt(sessionStorage.getItem('ben_session_hits') || '0');

        function getFatigueFactor() {
            const minutesWorking = (Date.now() - sessionStartTime) / 60000;
            const hitFatigue = Math.min(sessionHITsDone * 0.03, 0.5);
            const timeFatigue = Math.min(minutesWorking * 0.005, 0.3);
            return (1 + hitFatigue + timeFatigue) * personality.speedMultiplier;
        }

        // --- UI Dashboard ---
        function initDashboard() {
            if (document.getElementById('ben-ai-dash')) return;

            const dashStyle = document.createElement('style');
            dashStyle.textContent = `
                #ben-ai-dash {
                    position: fixed; bottom: 15px; left: 15px; width: 220px;
                    background: rgba(15, 23, 42, 0.9); color: #e2e8f0;
                    font-family: monospace; font-size: 13px; padding: 12px;
                    border-radius: 8px; border: 1px solid #334155;
                    box-shadow: 0 4px 12px rgba(0,0,0,0.5);
                    z-index: 999999; pointer-events: none;
                }
                .dash-row { margin-bottom: 4px; }
                .dash-label { color: #94a3b8; }
                .dash-val { color: #fde047; font-weight: bold; }
                .dash-status { margin-top: 8px; font-size: 11px; color: #a7f3d0; border-top: 1px dashed #475569; padding-top: 6px; }
                .dash-err { color: #f87171; }
            `;
            document.head.appendChild(dashStyle);

            const dash = document.createElement('div');
            dash.id = 'ben-ai-dash';
            dash.innerHTML = `
                <div id="dash-metrics">
                    <div class="dash-row"><span class="dash-label">Status:</span> <span class="dash-val">Ready</span></div>
                </div>
                <div id="dash-status" class="dash-status">Waiting for image...</div>
            `;
            document.body.appendChild(dash);
        }

        function updateStatus(text, isError = false) {
            const el = document.getElementById('dash-status');
            if (el) {
                el.innerHTML = text;
                el.className = isError ? 'dash-status dash-err' : 'dash-status';
            }
            console.log(isError ? `🚨 ${text}` : `ℹ️ ${text}`);
        }

        function updateMetrics(data) {
            const el = document.getElementById('dash-metrics');
            if (el) {
                el.innerHTML = `
                    <div class="dash-row"><span class="dash-label">Accept:</span> <span class="dash-val">${data.acceptable ? 'Yes' : 'No'}</span></div>
                    <div class="dash-row"><span class="dash-label">Smart:</span> <span class="dash-val">${data.smart}</span></div>
                    <div class="dash-row"><span class="dash-label">Trust:</span> <span class="dash-val">${data.trustworthy}</span></div>
                    <div class="dash-row"><span class="dash-label">Attract:</span> <span class="dash-val">${data.attractive}</span></div>
                    <div class="dash-row"><span class="dash-label">Note:</span> <span style="color:#cbd5e1">"${data.note || 'None'}"</span></div>
                `;
            }
        }

        initDashboard();

        window.addEventListener('beforeunload', () => {
            const dash = document.getElementById('ben-ai-dash');
            if (dash && dash.parentNode) dash.parentNode.removeChild(dash);
        });

        const tabId = sessionStorage.getItem('ben_tab_id') || 'default';

        let isProcessing = false;

        function stopForManualAction(reason) {
            isProcessing = false;
            updateStatus(`Paused: ${reason}. Please manually Skip/Submit.`, true);
        }

        function callGeminiAPI(modelName, imageUrl, prompt, temperature = 0.9) {
            return new Promise((resolve) => {
                const API_URL = `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`;

                GM_xmlhttpRequest({
                    method: "POST",
                    url: API_URL,
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${API_KEY}`
                    },
                    data: JSON.stringify({
                        model: modelName,
                        messages: [{
                            role: "user",
                            content: [
                                { type: "text", text: prompt },
                                { type: "image_url", image_url: { url: imageUrl } }
                            ]
                        }],
                        response_format: { type: "json_object" },
                        temperature: temperature
                    }),
                    timeout: 30000,
                    onload: (res) => {
                        try {
                            const responseJSON = JSON.parse(res.responseText);
                            if (responseJSON.error) resolve({ success: false, model: modelName, error: responseJSON.error.message });
                            else if (responseJSON.choices && responseJSON.choices[0] && responseJSON.choices[0].message) {
                                resolve({ success: true, model: modelName, text: responseJSON.choices[0].message.content });
                            } else {
                                resolve({ success: false, model: modelName, error: "No content in response" });
                            }
                        } catch (e) {
                            resolve({ success: false, model: modelName, error: "Parse Error" });
                        }
                    },
                    onerror: () => resolve({ success: false, model: modelName, error: "Network Error" }),
                    ontimeout: () => resolve({ success: false, model: modelName, error: "Timeout Error" })
                });
            });
        }

        async function processHIT() {
            if (isProcessing) return;

            const img = document.querySelector('.photo-container img, .rating-image img, img[src*="photofeeler"]')
                     || document.querySelector('img:not([src*=".svg"]):not([src*="chrome-extension"]):not([width="1"]):not([height="1"])');
            if (!img || !img.src) return;

            isProcessing = true;
            currentPhotoUrl = img.src;
            updateStatus("Processing...");
            updateStatus("Calling AI...");
            await getRatingFromGemini(img.src, 1);
        }

        // Prompt bank — different framings rotate per-HIT to prevent AI-fingerprint patterns
        const PROMPT_FRAMINGS = [
            "You are a picky, discerning rater. Most photos are mediocre. 3s should be very rare — reserved only for truly outstanding shots. Most photos land at 0, 1, or 2. Do NOT inflate.",
            "You are a regular casual person quickly rating a dating app photo. Give your honest gut reaction. Some photos are bad, some average, few great — use the whole range.",
            "You are analytical. For each trait, first ask: what visual evidence supports a high score here? If evidence is weak, score is 0 or 1. Base your score on the specific evidence, not general impression.",
            "You are a fair but critical judge. Real dating photos vary widely in quality — many are bad selfies, poor lighting, awkward angles. Score accordingly across the full 0-3 range."
        ];

        async function getRatingFromGemini(imageUrl, retryCount) {
            const framing = PROMPT_FRAMINGS[Math.floor(Math.random() * PROMPT_FRAMINGS.length)];
            const temperature = 0.6 + Math.random() * 0.7;
            console.log(`🎲 Prompt framing #${PROMPT_FRAMINGS.indexOf(framing)}, temp=${temperature.toFixed(2)}`);

            const prompt = `${framing}

You are rating a dating profile photo of a man. Look CAREFULLY at THIS specific photo before deciding.

Return ONLY valid JSON:
{
  "observation": "<one sentence describing what you actually see: setting, expression, clothing, lighting, framing, notable details>",
  "features": {
    "shirtless": <bool>,
    "glasses": <bool>,
    "sunglasses": <bool>,
    "hat": <bool>,
    "smiling": <bool>,
    "outdoor": <bool>,
    "professional_attire": <bool>,
    "grumpy_expression": <bool>
  },
  "acceptable": <bool>,
  "smart": <0-3>,
  "trustworthy": <0-3>,
  "attractive": <0-3>,
  "note": "<string, often empty>"
}

STEP 1 — "observation" + "features": First describe what is actually in THIS photo, then fill each feature boolean honestly based on your observation. This forces you to look at THIS specific image.

STEP 2 — "acceptable": true if any real person is visible (shirtless/blurry/sunglasses/hat are all OK). false ONLY for text memes, empty rooms, cartoons, or pure landscapes with no person.

STEP 3 — Rate each trait based on what YOUR observation actually shows. Scale: 0=No, 1=Somewhat, 2=Yes, 3=Very.

  SMART: intelligent cues in THIS photo — glasses, books, professional/refined setting, thoughtful expression, tidy presentation. Shirtless mirror selfies, party pics, sloppy backgrounds → 0-1. Reading, working, well-composed formal shots → 2-3.

  TRUSTWORTHY: honesty/warmth cues in THIS photo — genuine (not forced) smile, direct warm eye contact, open relaxed posture. Hidden eyes (shades, hats low), stern/aggressive face, closed body language → 0-1. Warm authentic smile, kind eyes → 2-3.

  ATTRACTIVE: overall photo appeal — physical features, grooming, lighting, angle, photo quality, style. Blurry, dark, unflattering angle, unkempt → 0-1. Sharp, flattering, well-groomed → 2-3.

STEP 4 — HARD RULES (from the site's official reviewer guidance):
  a) Each trait is a SEPARATE question — evaluate them INDEPENDENTLY. The reviewer explicitly said: "It is entirely possible to look attractive but not trustworthy". Almost every real photo has variance across traits.
  b) ABSOLUTELY FORBIDDEN: returning identical scores for all three traits (3,3,3 or 2,2,2 or 1,1,1 or 0,0,0). If your first instinct is identical, you are lazy-rating — re-do STEP 3 asking each trait as a separate question.
  c) FORBIDDEN: staying in a narrow window like only 1-2 or only 2-3 across many photos. The reviewer explicitly flags workers who never use the full 0-3 range. Use 0 and 3 when genuinely warranted.
  d) In a random pool of casual dating selfies: 3s are RARE (~10%), 2s common (~35%), 1s common (~30%), 0s occasional (~15%). Do NOT inflate to 2s and 3s reflexively.

STEP 5 — "note":
  DEFAULT is empty string "". Only write a note if something in YOUR observation genuinely jumps out (positive OR negative).
  If you write one: 2-5 casual lowercase words about the SPECIFIC detail you noticed, tone matching your scores. If scores are low, note should reflect that.
  Good notes: "love the outdoor bg", "cool jacket", "harsh shadow on face", "eyes hidden by shades", "cluttered kitchen bg", "great outfit choice".
  FORBIDDEN generic notes (never write these): "nice", "good photo", "looks good", "nice smile", "great pic", "background looks okay", "cool photo".`;

            for (let attempt = 1; attempt <= 2; attempt++) {
                updateStatus(`Trying 3.5-flash (Attempt ${attempt}/2)...`);
                const result = await callGeminiAPI("gemini-3.5-flash", imageUrl, prompt, temperature);

                if (result.success && result.text) {
                    try {
                        let cleanText = result.text.replace(/```json/gi, '').replace(/```/g, '').trim();
                        let parsedData = JSON.parse(cleanText);
                        if (parsedData.observation) console.log("📷 AI saw:", parsedData.observation);
                        updateMetrics(parsedData);
                        applyToForm(parsedData);
                        return;
                    } catch (e) {}
                }
                if (attempt < 2) await new Promise(r => setTimeout(r, 3000));
            }

            updateStatus("Fallback to 3.1-flash-lite...");
            const backupResult = await callGeminiAPI("gemini-3.1-flash-lite", imageUrl, prompt, temperature);

            if (backupResult.success && backupResult.text) {
                try {
                    let cleanText = backupResult.text.replace(/```json/gi, '').replace(/```/g, '').trim();
                    let parsedData = JSON.parse(cleanText);
                    if (parsedData.observation) console.log("📷 AI saw:", parsedData.observation);
                    updateMetrics(parsedData);
                    applyToForm(parsedData);
                    return;
                } catch (e) {}
            }

            stopForManualAction("API Error - Could not get valid rating");
        }

        // ==========================================
        // সেকশন ৪: True Human Mouse & Interaction System
        // ==========================================

        let currentMousePos = { x: window.innerWidth / 2, y: window.innerHeight / 2 };

        // Cubic Bezier interpolation — মানুষের হাত curved path-এ চলে
        function cubicBezier(t, p0, p1, p2, p3) {
            const mt = 1 - t;
            return mt*mt*mt*p0 + 3*mt*mt*t*p1 + 3*mt*t*t*p2 + t*t*t*p3;
        }

        // Scroll element into view — মানুষ দেখে তারপর click করে
        async function scrollToElement(element) {
            const rect = element.getBoundingClientRect();
            if (rect.top < 0 || rect.bottom > window.innerHeight) {
                element.scrollIntoView({ behavior: 'smooth', block: 'center' });
                await new Promise(r => setTimeout(r, Math.floor(Math.random() * 400) + 300));
            }
        }

        // Random idle mouse movement — কাজের মাঝে image-এর দিকে তাকানো
        async function randomIdleMovement() {
            if (isTabReallyHidden()) return;
            if (Math.random() > 0.35) return;

            const idleX = currentMousePos.x + (Math.random() - 0.5) * 200;
            const idleY = currentMousePos.y + (Math.random() - 0.5) * 150;
            const clampedX = Math.max(50, Math.min(window.innerWidth - 50, idleX));
            const clampedY = Math.max(50, Math.min(window.innerHeight - 50, idleY));

            const steps = Math.floor(Math.random() * 8) + 5;
            for (let i = 1; i <= steps; i++) {
                const t = i / steps;
                const x = currentMousePos.x + (clampedX - currentMousePos.x) * t + (Math.random() - 0.5) * 3;
                const y = currentMousePos.y + (clampedY - currentMousePos.y) * t + (Math.random() - 0.5) * 3;
                document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
                await new Promise(r => setTimeout(r, Math.floor(Math.random() * 25) + 15));
            }
            currentMousePos.x = clampedX;
            currentMousePos.y = clampedY;

            await new Promise(r => setTimeout(r, Math.floor(Math.random() * 500) + 200));
        }

        // Foreground: Bezier curve mouse movement + overshoot + correction
        async function simulateHumanMouseClick(element) {
            await scrollToElement(element);

            const rect = element.getBoundingClientRect();
            const targetX = rect.left + (rect.width * 0.15) + (Math.random() * rect.width * 0.7);
            const targetY = rect.top + (rect.height * 0.15) + (Math.random() * rect.height * 0.7);

            const startX = currentMousePos.x;
            const startY = currentMousePos.y;
            const distance = Math.sqrt((targetX - startX) ** 2 + (targetY - startY) ** 2);

            // Bezier control points — পথ curved করে
            const cpOffset = Math.max(distance * 0.25, 30);
            const cp1x = startX + (targetX - startX) * 0.3 + (Math.random() - 0.5) * cpOffset;
            const cp1y = startY + (targetY - startY) * 0.2 + (Math.random() - 0.5) * cpOffset;
            const cp2x = startX + (targetX - startX) * 0.7 + (Math.random() - 0.5) * cpOffset * 0.4;
            const cp2y = startY + (targetY - startY) * 0.8 + (Math.random() - 0.5) * cpOffset * 0.4;

            const steps = Math.floor(Math.random() * 12) + 18;
            const shouldOvershoot = Math.random() < 0.25;

            let actualTargetX = targetX;
            let actualTargetY = targetY;
            if (shouldOvershoot) {
                const overshootDist = Math.random() * 12 + 5;
                const angle = Math.atan2(targetY - startY, targetX - startX);
                actualTargetX = targetX + Math.cos(angle) * overshootDist;
                actualTargetY = targetY + Math.sin(angle) * overshootDist;
            }

            for (let i = 1; i <= steps; i++) {
                const t = i / steps;

                let x = cubicBezier(t, startX, cp1x, cp2x, actualTargetX);
                let y = cubicBezier(t, startY, cp1y, cp2y, actualTargetY);

                x += (Math.random() - 0.5) * 1.5;
                y += (Math.random() - 0.5) * 1.5;

                document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));

                // Variable speed: শুরু আর শেষে ধীর, মাঝখানে দ্রুত
                const speedCurve = Math.sin(t * Math.PI);
                const baseDelay = Math.floor(Math.random() * 12) + 8;
                const delay = baseDelay + Math.floor((1 - speedCurve) * 18);
                await new Promise(r => setTimeout(r, delay));
            }

            // Overshoot correction — overshoot হলে ফিরে আসা
            if (shouldOvershoot) {
                const corrSteps = Math.floor(Math.random() * 4) + 3;
                for (let i = 1; i <= corrSteps; i++) {
                    const t = i / corrSteps;
                    const x = actualTargetX + (targetX - actualTargetX) * t + (Math.random() - 0.5) * 1;
                    const y = actualTargetY + (targetY - actualTargetY) * t + (Math.random() - 0.5) * 1;
                    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
                    await new Promise(r => setTimeout(r, Math.floor(Math.random() * 20) + 12));
                }
            }

            currentMousePos.x = targetX;
            currentMousePos.y = targetY;

            // Pre-click hover — "পড়ছে" option টা
            element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: targetX, clientY: targetY }));
            element.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, clientX: targetX, clientY: targetY }));
            await new Promise(r => setTimeout(r, Math.floor(Math.random() * 200) + 80));

            // Click with pressure variation
            element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: targetX, clientY: targetY }));
            await new Promise(r => setTimeout(r, Math.floor(Math.random() * 90) + 35));
            element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: targetX, clientY: targetY }));

            element.click();
            if (element.parentElement) element.parentElement.click();
            let hiddenInput = element.querySelector('input');
            if (hiddenInput) hiddenInput.click();

            // Post-click micro settle — click করার পর হাত একটু নড়ে
            await new Promise(r => setTimeout(r, Math.floor(Math.random() * 60) + 30));
            const settleX = targetX + (Math.random() - 0.5) * 4;
            const settleY = targetY + (Math.random() - 0.5) * 4;
            document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: settleX, clientY: settleY }));

            return true;
        }

        // Background: synchronous dispatch — কোনো setTimeout নেই, deep nesting নেই
        function backgroundFastClick(element) {
            const rect = element.getBoundingClientRect();
            const targetX = rect.left + (rect.width * 0.2) + (Math.random() * rect.width * 0.6);
            const targetY = rect.top + (rect.height * 0.2) + (Math.random() * rect.height * 0.6);

            element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: targetX, clientY: targetY }));
            element.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, clientX: targetX, clientY: targetY }));
            element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: targetX, clientY: targetY }));
            element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: targetX, clientY: targetY }));
            element.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: targetX, clientY: targetY }));

            element.click();
            if (element.parentElement) element.parentElement.click();
            let hiddenInput = element.querySelector('input');
            if (hiddenInput) hiddenInput.click();

            currentMousePos.x = targetX;
            currentMousePos.y = targetY;
        }

        async function forceClickExactText(searchText, expectedIndex = 0) {
            const allElements = Array.from(document.body.querySelectorAll('*'));
            let matches = allElements.filter(el => {
                if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') return false;
                return el.textContent.replace(/\s+/g, ' ').trim() === searchText;
            });

            let deepestMatches = matches.filter(el => !matches.some(otherEl => el !== otherEl && el.contains(otherEl)));

            if (deepestMatches.length > expectedIndex) {
                let element = deepestMatches[expectedIndex];

                if (isTabReallyHidden()) {
                    await backgroundFastClick(element);
                } else {
                    await simulateHumanMouseClick(element);
                }
                return true;
            }
            return false;
        }

        // ==========================================
        // সেকশন ৫: Human-Like Typing System
        // ==========================================

        async function simulateHumanTyping(textarea, text) {
            if (isTabReallyHidden()) {
                textarea.value = text;
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
                textarea.dispatchEvent(new Event('change', { bubbles: true }));
                return;
            }

            textarea.focus();
            textarea.dispatchEvent(new Event('focus', { bubbles: true }));
            textarea.value = '';

            for (let i = 0; i < text.length; i++) {
                const char = text[i];

                textarea.dispatchEvent(new KeyboardEvent('keydown', { key: char, code: 'Key' + char.toUpperCase(), bubbles: true }));

                textarea.value += char;
                textarea.dispatchEvent(new Event('input', { bubbles: true }));

                textarea.dispatchEvent(new KeyboardEvent('keyup', { key: char, code: 'Key' + char.toUpperCase(), bubbles: true }));

                let delay = Math.floor(Math.random() * 200) + 130;

                if (char === ' ') delay += Math.floor(Math.random() * 400) + 150;

                if (Math.random() < 0.15) delay += Math.floor(Math.random() * 800) + 300;

                await new Promise(r => setTimeout(r, delay));
            }

            textarea.dispatchEvent(new Event('change', { bubbles: true }));
        }

        // ==========================================
        // সেকশন ৬: Form Filling with Human Timing
        // ==========================================

        function bgAwareSleep(foregroundMs) {
            if (isTabReallyHidden()) {
                const bgMs = Math.floor(Math.random() * 1900) + 600;
                return new Promise(resolve => setTimeout(resolve, bgMs));
            }
            const fatigue = getFatigueFactor();
            return new Promise(resolve => setTimeout(resolve, Math.floor(foregroundMs * fatigue)));
        }

        const clamp = (v) => Math.max(0, Math.min(3, Math.round(Number(v) || 0)));

        function applyToForm(data) {
            updateStatus("Studying the photo...");

            data.acceptable = (data.acceptable === true || data.acceptable === "true");

            // Opinion bias from AI-detected features (per-personality quirks)
            const opinionBias = applyOpinionBias(data.features || {});

            // Adaptive session-wide harshness (self-correcting against inflation)
            const adaptive = computeAdaptiveHarshness();

            data.smart = applyRatingNoise(clamp(data.smart), personality.ratingBias.smart, opinionBias.smart + adaptive);
            data.trustworthy = applyRatingNoise(clamp(data.trustworthy), personality.ratingBias.trustworthy, opinionBias.trustworthy + adaptive);
            data.attractive = applyRatingNoise(clamp(data.attractive), personality.ratingBias.attractive, opinionBias.attractive + adaptive);

            const traitKeys = ['smart', 'trustworthy', 'attractive'];

            // Suppress excess 3s to keep distribution realistic
            if (shouldSuppressHighScore()) {
                traitKeys.forEach(k => {
                    if (data[k] === 3 && Math.random() < 0.55) data[k] = 2;
                });
            }

            // Inject an occasional 0 if session lacks them
            if (shouldForceLowScore()) {
                const scoresNow = traitKeys.map(k => data[k]);
                const minIdx = scoresNow.indexOf(Math.min(...scoresNow));
                data[traitKeys[minIdx]] = 0;
            }

            let scores = traitKeys.map(k => data[k]);
            const uniqueScores = new Set(scores);
            const scoreRange = Math.max(...scores) - Math.min(...scores);

            if (uniqueScores.size === 1) {
                const pick = traitKeys[Math.floor(Math.random() * 3)];
                data[pick] = clamp(data[pick] + (data[pick] >= 2 ? -1 : 1));
                const pick2 = traitKeys.filter(k => k !== pick)[Math.floor(Math.random() * 2)];
                if (Math.random() < 0.5) {
                    data[pick2] = clamp(data[pick2] + (data[pick2] >= 2 ? -1 : 1));
                }
            } else if (scoreRange === 1 && Math.random() < 0.4) {
                const highIdx = scores.indexOf(Math.max(...scores));
                data[traitKeys[highIdx]] = clamp(scores[highIdx] - 1);
            }

            scores = traitKeys.map(k => data[k]);
            if (scores.every(s => s >= 2) && Math.random() < 0.4) {
                const pick = traitKeys[Math.floor(Math.random() * 3)];
                data[pick] = clamp(data[pick] - (Math.random() < 0.4 ? 2 : 1));
            }

            // Per-photo drift: if we've seen this photo before, shift a score sometimes (human inconsistency)
            if (currentPhotoUrl) {
                const photoId = extractPhotoId(currentPhotoUrl);
                const mem = getPhotoMemory();
                const prev = mem[photoId];
                if (prev && Math.random() < 0.35) {
                    const pick = traitKeys[Math.floor(Math.random() * 3)];
                    const shift = Math.random() < 0.5 ? 1 : -1;
                    data[pick] = clamp(data[pick] + shift);
                    console.log(`🔄 Photo seen before — drifted ${pick} by ${shift}`);
                }
                mem[photoId] = { s: data.smart, t: data.trustworthy, a: data.attractive, ts: Date.now(), t2: Date.now() };
                savePhotoMemory(mem);
            }

            // Occasional intentional "mistake" — real humans misjudge 2-3% of the time
            if (Math.random() < 0.025) {
                const pick = traitKeys[Math.floor(Math.random() * 3)];
                const wrongShift = Math.random() < 0.5 ? 1 : -1;
                const newVal = clamp(data[pick] + wrongShift);
                if (newVal !== data[pick]) {
                    console.log(`🎯 Intentional human mistake: ${pick} ${data[pick]} → ${newVal}`);
                    data[pick] = newVal;
                }
            }

            // BULLETPROOF FINAL CHECK — Ben's #1 rule: NEVER identical scores across all 3 traits
            // This is the last line of defense — no matter what happened above, if we somehow
            // still have 3,3,3 or 2,2,2 etc, force a change here.
            let finalScores = traitKeys.map(k => data[k]);
            if (new Set(finalScores).size === 1) {
                const pick = traitKeys[Math.floor(Math.random() * 3)];
                if (data[pick] === 3) data[pick] = 2;
                else if (data[pick] === 0) data[pick] = 1;
                else data[pick] = data[pick] + (Math.random() < 0.5 ? 1 : -1);
                data[pick] = clamp(data[pick]);
                console.log(`🛡️ BULLETPROOF: identical scores detected, forced ${pick} to ${data[pick]}`);
            }

            // Record final scores in session distribution
            recordScore(data.smart);
            recordScore(data.trustworthy);
            recordScore(data.attractive);

            const metricsEl = document.getElementById('dash-metrics');
            if (metricsEl) {
                const rows = metricsEl.querySelectorAll('.dash-row');
                if (rows[1]) rows[1].querySelector('.dash-val').textContent = data.smart;
                if (rows[2]) rows[2].querySelector('.dash-val').textContent = data.trustworthy;
                if (rows[3]) rows[3].querySelector('.dash-val').textContent = data.attractive;
            }

            if (data.acceptable && Math.random() < personality.skipRate) {
                updateStatus("Skipping this one (natural skip)...");
                setTimeout(async () => {
                    let clicked = await forceClickExactText('Skip', 0);
                    if (!clicked) clicked = await forceClickExactText('Submit', 0);
                    isProcessing = false;
                }, logNormalDelay(2000, 0.5));
                return;
            }

            const thinkingTime = isTabReallyHidden()
                ? logNormalDelay(1200, 0.6)
                : logNormalDelay(3000 * getFatigueFactor(), 0.4);

            setTimeout(async () => {
                try {
                    if (Math.random() < personality.distractionRate) {
                        const distractMs = Math.floor(Math.random() * 70000) + 20000;
                        updateStatus("(distracted pause)...");
                        await new Promise(r => setTimeout(r, distractMs));
                    }

                    await randomIdleMovement();

                    let acceptText = data.acceptable ? "Yes" : "No";
                    let clickedAccept = await forceClickExactText(acceptText, 0);
                    if (!clickedAccept) {
                        stopForManualAction("Could not click Accept/Reject button");
                        return;
                    }

                    if (!data.acceptable) {
                        updateStatus("AI said not acceptable — reloading for new photo...");
                        await bgAwareSleep(logNormalDelay(1500, 0.5));
                        location.reload();
                        return;
                    }


                    await bgAwareSleep(logNormalDelay(1500, 0.5));
                    await randomIdleMovement();

                    const textMap = { 3: "3 Very", 2: "2 Yes", 1: "1 Somewhat", 0: "0 No" };

                    const clickScore = async (trait, score) => {
                        const traitIndex = { 'smart': 0, 'trustworthy': 1, 'attractive': 2 }[trait];

                        if (Math.random() < personality.correctionRate) {
                            const wrongScore = (score + (Math.random() < 0.5 ? 1 : -1) + 4) % 4;
                            await forceClickExactText(textMap[wrongScore], traitIndex);
                            await bgAwareSleep(logNormalDelay(1800, 0.4));
                        }

                        let clicked = await forceClickExactText(textMap[score], traitIndex);
                        if (!clicked) throw new Error(`Failed to click rating for ${trait}`);

                        if (Math.random() < 0.2) {
                            await bgAwareSleep(logNormalDelay(400, 0.6));
                        }
                    };

                    const traits = [
                        { name: 'smart', score: data.smart },
                        { name: 'trustworthy', score: data.trustworthy },
                        { name: 'attractive', score: data.attractive }
                    ];
                    if (personality.traitOrder === 'shuffled' && Math.random() < 0.5) {
                        for (let i = traits.length - 1; i > 0; i--) {
                            const j = Math.floor(Math.random() * (i + 1));
                            [traits[i], traits[j]] = [traits[j], traits[i]];
                        }
                    }

                    for (let t = 0; t < traits.length; t++) {
                        if (t > 0) {
                            const delayMedian = [0, 1800, 2200, 2800][t] || 2000;
                            await bgAwareSleep(logNormalDelay(delayMedian, 0.5));
                            if (Math.random() < 0.35) await randomIdleMovement();
                        }
                        await clickScore(traits[t].name, traits[t].score);
                    }

                    await bgAwareSleep(logNormalDelay(800, 0.5));

                    const allElements = Array.from(document.body.querySelectorAll('*'));
                    let skipExists = allElements.filter(el => {
                        if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') return false;
                        return el.textContent.replace(/\s+/g, ' ').trim() === 'Skip';
                    }).filter((el, index, arr) => !arr.some(otherEl => el !== otherEl && el.contains(otherEl))).length > 0;

                    if (skipExists) {
                        const noteRate = personality.noteRate || 0.22;
                        const shouldWriteNote = Math.random() < noteRate;
                        const rawNote = (data.note || '').trim().toLowerCase();
                        const genericNotes = ['nice', 'good photo', 'looks good', 'nice smile', 'great pic', 'background looks okay', 'cool photo', 'good', 'great', 'ok', 'okay', 'nice pic', 'good pic', 'love it', 'awesome'];
                        const isGeneric = genericNotes.some(g => rawNote === g || rawNote.startsWith(g + ' ') || rawNote.endsWith(' ' + g));
                        const hasValidNote = rawNote.length > 3 && rawNote.length < 40 && !isGeneric;
                        const avgScore = (data.smart + data.trustworthy + data.attractive) / 3;

                        // Cross-tab dedup: don't reuse recent notes across MTurk accounts
                        const alreadyUsed = hasValidNote && isNoteRecentlyUsed(rawNote);

                        // Tone match: no positive notes on low ratings
                        const positiveWords = ['great', 'love', 'nice', 'cool', 'awesome', 'perfect', 'beautiful', 'wonderful', 'amazing', 'good'];
                        const negativeWords = ['bad', 'poor', 'harsh', 'blurry', 'dark', 'cluttered', 'unflattering', 'awkward', 'weird'];
                        const noteIsPositive = positiveWords.some(w => rawNote.includes(w));
                        const noteIsNegative = negativeWords.some(w => rawNote.includes(w));
                        const anyZero = data.smart === 0 || data.trustworthy === 0 || data.attractive === 0;
                        const toneMismatch = (noteIsPositive && (avgScore < 1.5 || anyZero)) || (noteIsNegative && avgScore >= 2.3);

                        if (shouldWriteNote && hasValidNote && !alreadyUsed && !toneMismatch && avgScore >= 1.3) {
                            updateStatus("Writing comment...");
                            const styledNote = styleNote(data.note.trim());
                            let textarea = document.querySelector('textarea');
                            if (textarea) {
                                await simulateHumanTyping(textarea, styledNote);
                            }
                            addUsedNote(styledNote);
                            await bgAwareSleep(logNormalDelay(600, 0.4));
                        } else {
                            console.log(`ℹ️ No note (rate=${noteRate.toFixed(2)}, roll=${shouldWriteNote}, valid=${hasValidNote}, used=${alreadyUsed}, toneMismatch=${toneMismatch}, avg=${avgScore.toFixed(1)})`);
                        }
                    }

                    updateStatus("Reviewing before submit...");
                    await bgAwareSleep(logNormalDelay(1500, 0.6));
                    if (Math.random() < 0.35) await randomIdleMovement();

                    await bgAwareSleep(isTabReallyHidden()
                        ? logNormalDelay(800, 0.5)
                        : logNormalDelay(2000 * getFatigueFactor(), 0.4));

                    try {
                        sessionStorage.setItem('ben_just_submitted', 'true');
                        sessionHITsDone++;
                        sessionStorage.setItem('ben_session_hits', sessionHITsDone.toString());

                        let clickedSubmit = await forceClickExactText('Submit', 0);
                        if (!clickedSubmit) {
                            stopForManualAction("Submit button not found");
                        } else {
                            updateStatus("Submitted!");
                            setTimeout(() => { isProcessing = false; }, 2000);
                        }
                    } catch (submitErr) {
                        console.error("Error clicking Submit:", submitErr);
                        stopForManualAction("Submit Execution Failed");
                    }

                } catch (err) {
                    console.error("Error in form:", err);
                    stopForManualAction(err.message || "Form Script Error");
                }
            }, thinkingTime);
        }

        // Image detection
        function initImageObserver() {
            const imgSelector = 'img:not([src*=".svg"]):not([src*="chrome-extension"]):not([width="1"]):not([height="1"])';
            const specificSelector = '.photo-container img, .rating-image img, img[src*="photofeeler"]';

            const existingImg = document.querySelector(specificSelector) || document.querySelector(imgSelector);

            if (existingImg) {
                if (existingImg.complete && existingImg.naturalWidth > 0) {
                    processHIT();
                } else {
                    existingImg.addEventListener('load', () => processHIT(), { once: true });
                    existingImg.addEventListener('error', () => processHIT(), { once: true });
                    setTimeout(() => processHIT(), 5000);
                }
            } else {
                const observer = new MutationObserver((mutations, obs) => {
                    const img = document.querySelector(specificSelector) || document.querySelector(imgSelector);
                    if (img) {
                        obs.disconnect();
                        if (img.complete && img.naturalWidth > 0) {
                            processHIT();
                        } else {
                            img.addEventListener('load', () => processHIT(), { once: true });
                            img.addEventListener('error', () => processHIT(), { once: true });
                            setTimeout(() => processHIT(), 5000);
                        }
                    }
                });
                observer.observe(document.body, { childList: true, subtree: true });

                setTimeout(() => {
                    observer.disconnect();
                    const img = document.querySelector(specificSelector) || document.querySelector(imgSelector);
                    if (img && !isProcessing) processHIT();
                }, 10000);
            }
        }

        initImageObserver();
    }
})();
