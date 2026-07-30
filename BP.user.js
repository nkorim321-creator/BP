// ==UserScript==
// @name         MTurk Human-Like Rater (Version 27.0 - Stealth)
// @namespace    http://tampermonkey.net/
// @version      27.1
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
                harshness: -0.15 + seed() * 0.3,
                traitOrder: seed() < 0.15 ? 'shuffled' : 'normal',
                skipRate: 0.005 + seed() * 0.025,
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

        function applyRatingNoise(score, traitBias) {
            const combined = traitBias + personality.harshness;
            let noised = score;

            if (Math.random() < Math.abs(combined) * 0.15) {
                noised += combined > 0 ? 1 : -1;
            }

            return Math.max(0, Math.min(3, Math.round(noised)));
        }

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

        function callGeminiAPI(modelName, imageUrl, prompt) {
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
                        temperature: 0.9
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
            updateStatus("Processing...");
            updateStatus("Calling AI...");
            await getRatingFromGemini(img.src, 1);
        }

        async function getRatingFromGemini(imageUrl, retryCount) {
            const prompt = `Rate this dating photo. Return ONLY valid JSON: {"acceptable": bool, "smart": 0-3, "trustworthy": 0-3, "attractive": 0-3, "note": string}

Scale: 0=No 1=Somewhat 2=Yes 3=Very. Be honest and use the FULL range - many photos deserve 0 or 1. Do NOT inflate scores. Rate each trait INDEPENDENTLY since they measure different things - scores should usually differ from each other.

"note": mention ONE specific visible detail (2-5 casual words) like their smile, eyes, outfit, background, lighting, pose. If scores are mostly low, keep note neutral not positive. If nothing specific stands out, return empty string "". Good: "love the outdoor bg", "cool jacket", "eyes look kind". Bad (NEVER use): "nice", "good photo", "looks good", "nice smile", "great pic".

"acceptable": false ONLY if no real person visible or it's a meme/screenshot.`;

            for (let attempt = 1; attempt <= 2; attempt++) {
                updateStatus(`Trying 3.1-flash-lite (Attempt ${attempt}/2)...`);
                const result = await callGeminiAPI("gemini-3.1-flash-lite", imageUrl, prompt);

                if (result.success && result.text) {
                    try {
                        let cleanText = result.text.replace(/```json/gi, '').replace(/```/g, '').trim();
                        let parsedData = JSON.parse(cleanText);
                        updateMetrics(parsedData);
                        applyToForm(parsedData);
                        return;
                    } catch (e) {}
                }
                if (attempt < 2) await new Promise(r => setTimeout(r, 3000));
            }

            updateStatus("Fallback to 3.5-flash...");
            const backupResult = await callGeminiAPI("gemini-3.5-flash", imageUrl, prompt);

            if (backupResult.success && backupResult.text) {
                try {
                    let cleanText = backupResult.text.replace(/```json/gi, '').replace(/```/g, '').trim();
                    let parsedData = JSON.parse(cleanText);
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
            data.smart = applyRatingNoise(clamp(data.smart), personality.ratingBias.smart);
            data.trustworthy = applyRatingNoise(clamp(data.trustworthy), personality.ratingBias.trustworthy);
            data.attractive = applyRatingNoise(clamp(data.attractive), personality.ratingBias.attractive);

            if (data.smart === data.trustworthy && data.trustworthy === data.attractive) {
                const traitKeys = ['smart', 'trustworthy', 'attractive'];
                const pick = traitKeys[Math.floor(Math.random() * 3)];
                data[pick] = clamp(data[pick] + (data[pick] >= 2 ? -1 : 1));
            }

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
                        const shouldWriteNote = Math.random() < 0.22;
                        const hasValidNote = data.note && typeof data.note === 'string' && data.note.trim().length > 3;
                        const avgScore = (data.smart + data.trustworthy + data.attractive) / 3;

                        if (shouldWriteNote && hasValidNote && avgScore >= 1.5) {
                            updateStatus("Writing comment...");
                            let textarea = document.querySelector('textarea');
                            if (textarea) {
                                await simulateHumanTyping(textarea, data.note.trim());
                            }
                            await bgAwareSleep(logNormalDelay(600, 0.4));
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
