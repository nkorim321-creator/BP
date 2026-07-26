// ==UserScript==
// @name         MTurk Human-Like Rater (Version 24.6 - Background Tab Fix)
// @namespace    http://tampermonkey.net/
// @version      24.6
// @description  Fixed: background tabs no longer stuck + isProcessing lock + click verification + submit try-catch
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
    // সেকশন ০: Background Tab Fix
    // ==========================================

    // আসল visibility state সেভ করো OVERRIDE করার আগে
    const nativeHiddenGetter = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden')?.get
                            || Object.getOwnPropertyDescriptor(HTMLDocument.prototype, 'hidden')?.get;

    function isTabReallyHidden() {
        if (nativeHiddenGetter) return nativeHiddenGetter.call(document);
        return !document.hasFocus();
    }

    // Override — page-এর নিজের script যেন মনে করে tab visible আছে
    Object.defineProperty(document, 'hidden', { configurable: true, get: function() { return false; } });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: function() { return 'visible'; } });
    window.addEventListener('visibilitychange', e => e.stopPropagation(), true);

    const currentUrl = window.location.href;

    // API Key with menu to change
    let API_KEY = GM_getValue('gemini_api_key', 'AQ.Ab8RN6IsscYPFLrkKdF51-vADwOiiIExBwO9AjAB7SZZ_grcQw');

    GM_registerMenuCommand('Change Gemini API Key', () => {
        const newKey = prompt('Enter new Gemini API Key:', API_KEY);
        if (newKey && newKey.trim() !== '') {
            GM_setValue('gemini_api_key', newKey.trim());
            alert('API Key updated! Reloading page...');
            location.reload();
        }
    });

    if (!API_KEY) {
        API_KEY = prompt('Enter Gemini API Key:');
        GM_setValue('gemini_api_key', API_KEY);
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
                .dash-title { color: #38bdf8; font-weight: bold; border-bottom: 1px solid #334155; padding-bottom: 6px; margin-bottom: 8px; }
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
                <div class="dash-title">🤖 AI Rater v24.6</div>
                <div id="dash-metrics">
                    <div class="dash-row"><span class="dash-label">Target HITs:</span> <span class="dash-val" id="d-hit">Loading...</span></div>
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

        function updateMetrics(data, modelName) {
            const el = document.getElementById('dash-metrics');
            if (el) {
                el.innerHTML = `
                    <div class="dash-row"><span class="dash-label">Model:</span> <span style="color:#6ee7b7">${modelName.replace('gemini-', '')}</span></div>
                    <div class="dash-row"><span class="dash-label">Accept:</span> <span class="dash-val">${data.acceptable ? 'Yes ✅' : 'No ❌'}</span></div>
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

        let hitCount = parseInt(localStorage.getItem('ben_hit_count') || '0');
        let nextTarget = parseInt(localStorage.getItem('ben_note_target') || '0');

        if (nextTarget === 0) {
            nextTarget = Math.floor(Math.random() * (15 - 6 + 1)) + 6;
            localStorage.setItem('ben_note_target', nextTarget.toString());
        }

        const hitDisplay = document.getElementById('d-hit');
        if (hitDisplay) hitDisplay.innerText = `${hitCount + 1} / ${nextTarget}`;

        let isProcessing = false;

        function stopForManualAction(reason) {
            isProcessing = false;
            updateStatus(`Paused: ${reason}. Please manually Skip/Submit.`, true);
        }

        function callGeminiAPI(modelName, payload) {
            return new Promise((resolve) => {
                const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;

                GM_xmlhttpRequest({
                    method: "POST",
                    url: API_URL,
                    headers: { "Content-Type": "application/json", "x-goog-api-key": API_KEY },
                    data: JSON.stringify(payload),
                    timeout: 30000,
                    onload: (res) => {
                        try {
                            const responseJSON = JSON.parse(res.responseText);
                            if (responseJSON.error) resolve({ success: false, model: modelName, error: responseJSON.error.message, raw: responseJSON });
                            else resolve({ success: true, model: modelName, data: responseJSON });
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
            if (!img) return;

            isProcessing = true;
            updateStatus("Downloading & compressing image...");

            GM_xmlhttpRequest({
                method: 'GET',
                url: img.src,
                responseType: 'blob',
                timeout: 15000,
                onload: function(response) {
                    if (response.status !== 200) { stopForManualAction("Broken Image Link"); return; }

                    const urlCreator = window.URL || window.webkitURL;
                    const imageUrl = urlCreator.createObjectURL(response.response);
                    const imgObj = new Image();

                    imgObj.onload = async function() {
                        try {
                            const canvas = document.createElement('canvas');
                            const MAX_WIDTH = 375;
                            const MAX_HEIGHT = 375;
                            let width = imgObj.width;
                            let height = imgObj.height;

                            if (width > height) {
                                if (width > MAX_WIDTH) { height *= MAX_WIDTH / width; width = MAX_WIDTH; }
                            } else {
                                if (height > MAX_HEIGHT) { width *= MAX_HEIGHT / height; height = MAX_HEIGHT; }
                            }

                            canvas.width = width; canvas.height = height;
                            const ctx = canvas.getContext('2d');
                            ctx.drawImage(imgObj, 0, 0, width, height);

                            const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
                            const base64Image = dataUrl.split(',')[1];
                            urlCreator.revokeObjectURL(imageUrl);

                            updateStatus("Calling AI...");
                            await getRatingFromGemini(base64Image, 1);
                        } catch (canvasErr) {
                            urlCreator.revokeObjectURL(imageUrl);
                            stopForManualAction("Image Compression Failed");
                        }
                    };

                    imgObj.onerror = function() {
                        urlCreator.revokeObjectURL(imageUrl);
                        stopForManualAction("Image Format Error");
                    };

                    imgObj.src = imageUrl;
                },
                onerror: function() { stopForManualAction("Network Error"); },
                ontimeout: function() { stopForManualAction("Timeout downloading image"); }
            });
        }

        async function getRatingFromGemini(base64Image, retryCount) {
            const payload = {
                contents: [{
                    parts: [
                        { text: `Rate dating photo. AVOID BOT BEHAVIOR. 1. NEVER give same scores (e.g. 3,3,3). 2. Rate 0-3 separately per trait. Be strict, use 0/1 often. 3. Return ONLY JSON: acceptable (bool, false if meme/no person), smart (0-3), trustworthy (0-3), attractive (0-3). 5. "note": string (ALWAYS write a very short, realistic 1 to 3 word compliment just in case it's needed).` },
                        { inline_data: { mime_type: "image/jpeg", data: base64Image } }
                    ]
                }],
                safetySettings: [
                    { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                    { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                    { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
                ],
                generationConfig: { responseMimeType: "application/json", temperature: 0.7 }
            };

            for (let attempt = 1; attempt <= 2; attempt++) {
                updateStatus(`Trying 3.1-flash-lite (Attempt ${attempt}/2)...`);
                const result = await callGeminiAPI("gemini-3.1-flash-lite", payload);

                if (result.success && result.data.candidates?.[0]?.content?.parts?.[0]?.text) {
                    try {
                        let cleanText = result.data.candidates[0].content.parts[0].text.replace(/```json/gi, '').replace(/```/g, '').trim();
                        let parsedData = JSON.parse(cleanText);
                        updateMetrics(parsedData, "gemini-3.1-flash-lite");
                        applyToForm(parsedData);
                        return;
                    } catch (e) { console.error("Parse error", e); }
                }
                if (attempt < 2) await new Promise(r => setTimeout(r, 3000));
            }

            updateStatus("Fallback to 3.5-flash...");
            const backupResult = await callGeminiAPI("gemini-3.5-flash", payload);

            if (backupResult.success && backupResult.data.candidates?.[0]?.content?.parts?.[0]?.text) {
                try {
                    let cleanText = backupResult.data.candidates[0].content.parts[0].text.replace(/```json/gi, '').replace(/```/g, '').trim();
                    let parsedData = JSON.parse(cleanText);
                    updateMetrics(parsedData, "gemini-3.5-flash");
                    applyToForm(parsedData);
                    return;
                } catch (e) { console.error("Parse error", e); }
            }

            stopForManualAction("API Error - Could not get valid rating");
        }

        // ==========================================
        // Background-Aware Click System
        // ==========================================

        let currentMousePos = { x: window.innerWidth / 2, y: window.innerHeight / 2 };

        // Background-safe: সরাসরি event dispatch, কোনো mousemove loop নেই
        async function backgroundFastClick(element) {
            const rect = element.getBoundingClientRect();
            const targetX = rect.left + (rect.width * 0.2) + (Math.random() * rect.width * 0.6);
            const targetY = rect.top + (rect.height * 0.2) + (Math.random() * rect.height * 0.6);

            element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: targetX, clientY: targetY }));
            element.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, clientX: targetX, clientY: targetY }));
            await new Promise(r => setTimeout(r, Math.floor(Math.random() * 30) + 20));

            element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: targetX, clientY: targetY }));
            await new Promise(r => setTimeout(r, Math.floor(Math.random() * 50) + 30));

            element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: targetX, clientY: targetY }));
            element.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: targetX, clientY: targetY }));

            if (element.parentElement) {
                element.parentElement.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: targetX, clientY: targetY }));
            }
            let hiddenInput = element.querySelector('input');
            if (hiddenInput) {
                await new Promise(r => setTimeout(r, 20));
                hiddenInput.click();
            }

            currentMousePos.x = targetX;
            currentMousePos.y = targetY;
        }

        // Foreground-only: মাউস মুভমেন্ট সিমুলেশন সহ
        async function simulateHumanMouseClick(element) {
            const rect = element.getBoundingClientRect();
            const targetX = rect.left + (rect.width * 0.2) + (Math.random() * rect.width * 0.6);
            const targetY = rect.top + (rect.height * 0.2) + (Math.random() * rect.height * 0.6);
            const steps = Math.floor(Math.random() * 15) + 15;

            for (let i = 1; i <= steps; i++) {
                const t = i / steps; const easeT = t * (2 - t);
                const x = currentMousePos.x + (targetX - currentMousePos.x) * easeT;
                const y = currentMousePos.y + (targetY - currentMousePos.y) * easeT;
                element.ownerDocument.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
                await new Promise(r => setTimeout(r, Math.floor(Math.random() * 20) + 15));
            }
            currentMousePos.x = targetX; currentMousePos.y = targetY;
            element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: targetX, clientY: targetY }));
            element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: targetX, clientY: targetY }));
            await new Promise(r => setTimeout(r, Math.floor(Math.random() * 80) + 40));
            element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: targetX, clientY: targetY }));
            element.click();
            if (element.parentElement) element.parentElement.click();
            let hiddenInput = element.querySelector('input');
            if (hiddenInput) hiddenInput.click();
            return true;
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

                // isTabReallyHidden() ব্যবহার করো, override করা document.hidden না
                if (isTabReallyHidden()) {
                    await backgroundFastClick(element);
                } else {
                    await simulateHumanMouseClick(element);
                }
                return true;
            }
            return false;
        }

        // Background-aware delay: hidden tab-এ ছোট delay ব্যবহার করো
        function bgAwareSleep(foregroundMs) {
            const ms = isTabReallyHidden() ? Math.min(foregroundMs, 200) : foregroundMs;
            return new Promise(resolve => setTimeout(resolve, ms));
        }

        const clamp = (v) => Math.max(0, Math.min(3, Math.round(Number(v) || 0)));

        function applyToForm(data) {
            updateStatus("Applying AI scores...");

            data.acceptable = (data.acceptable === true || data.acceptable === "true");
            data.smart = clamp(data.smart);
            data.trustworthy = clamp(data.trustworthy);
            data.attractive = clamp(data.attractive);

            const startDelay = isTabReallyHidden() ? Math.floor(Math.random() * 500) + 300 : Math.floor(Math.random() * 2000) + 2000;

            setTimeout(async () => {
                try {
                    let acceptText = data.acceptable ? "Yes" : "No";
                    let clickedAccept = await forceClickExactText(acceptText, 0);
                    if (!clickedAccept) {
                        stopForManualAction("Could not click Accept/Reject button");
                        return;
                    }

                    if (!data.acceptable) {
                        stopForManualAction("AI evaluated 'No Person/Meme'");
                        return;
                    }

                    hitCount++;
                    let writeNoteThisTime = false;
                    if (hitCount >= nextTarget) {
                        writeNoteThisTime = true;
                        localStorage.setItem('ben_hit_count', '0');
                        localStorage.setItem('ben_note_target', '0');
                    } else {
                        localStorage.setItem('ben_hit_count', hitCount.toString());
                    }

                    await bgAwareSleep(Math.floor(Math.random() * 800) + 500);
                    const textMap = { 3: "3 Very", 2: "2 Yes", 1: "1 Somewhat", 0: "0 No" };

                    const clickScore = async (trait, score) => {
                        const traitIndex = { 'smart': 0, 'trustworthy': 1, 'attractive': 2 }[trait];
                        let clicked = await forceClickExactText(textMap[score], traitIndex);
                        if (!clicked) throw new Error(`Failed to click rating for ${trait}`);
                    };

                    await clickScore('smart', data.smart);
                    await bgAwareSleep(Math.floor(Math.random() * 800) + 600);

                    await clickScore('trustworthy', data.trustworthy);
                    await bgAwareSleep(Math.floor(Math.random() * 800) + 600);

                    await clickScore('attractive', data.attractive);
                    await bgAwareSleep(Math.floor(Math.random() * 800) + 600);

                    const allElements = Array.from(document.body.querySelectorAll('*'));
                    let skipExists = allElements.filter(el => {
                        if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') return false;
                        return el.textContent.replace(/\s+/g, ' ').trim() === 'Skip';
                    }).filter((el, index, arr) => !arr.some(otherEl => el !== otherEl && el.contains(otherEl))).length > 0;

                    if (writeNoteThisTime || skipExists) {
                        updateStatus("Adding comment...");
                        let fallbackNote = (data.note && typeof data.note === 'string' && data.note.trim() !== "") ? data.note : "Great photo";
                        let textarea = document.querySelector('textarea');
                        if (textarea) {
                            textarea.value = fallbackNote;
                            textarea.dispatchEvent(new Event('input', { bubbles: true }));
                            textarea.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                        await bgAwareSleep(Math.floor(Math.random() * 800) + 500);
                    }

                    updateStatus("Submitting...");
                    const submitDelay = isTabReallyHidden() ? Math.floor(Math.random() * 500) + 300 : Math.floor(Math.random() * 2000) + 1500;

                    setTimeout(async () => {
                        try {
                            sessionStorage.setItem('ben_just_submitted', 'true');
                            let clickedSubmit = await forceClickExactText('Submit', 0);
                            if (!clickedSubmit) {
                                stopForManualAction("Submit button not found");
                            } else {
                                setTimeout(() => { isProcessing = false; }, 2000);
                            }
                        } catch (submitErr) {
                            console.error("Error clicking Submit:", submitErr);
                            stopForManualAction("Submit Execution Failed");
                        }
                    }, submitDelay);

                } catch (err) {
                    console.error("Error in form:", err);
                    stopForManualAction(err.message || "Form Script Error");
                }
            }, startDelay);
        }

        // Image detection with MutationObserver + fallback
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
