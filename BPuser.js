// ==UserScript==
// @name         MTurk Human-Like Rater (Version 17.0 - Auto-Reload & Manual Review)
// @namespace    http://tampermonkey.net/
// @version      17.0
// @description  Stops auto-submit for 'No', Auto-reloads on freeze, Dynamic Comments, Force Close
// @author       You
// @match        *://worker.mturk.com/*
// @match        *://*.photofeeler.com/*
// @match        *://*.mturkcontent.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @connect      photos.benpeterson.info
// @connect      generativelanguage.googleapis.com
// ==/UserScript==

(function() {
    'use strict';

    const currentUrl = window.location.href;
    const API_KEY = 'AQ.Ab8RN6I7Ids4sJIJxcIdYAQJN04OsoaltyubwkxQKBfsvzebEQ'; 

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
    // সেকশন ২: অটো-ওপেনার লজিক (Smart Memory)
    // ==========================================
    if (currentUrl.includes("worker.mturk.com/tasks") && !currentUrl.includes("/projects/")) {
        console.log("🤖 Queue Page Detected: Starting Background Auto-Opener...");
        
        setInterval(() => {
            let openedHITs = JSON.parse(sessionStorage.getItem('ben_opened_hits') || '[]');
            const rows = document.querySelectorAll('.table-row, tr'); 
            
            rows.forEach(row => {
                if (row.textContent.includes('Ben Peterson')) {
                    const workBtn = row.querySelector('a[href*="/tasks/"]');
                    if (workBtn && workBtn.textContent.includes('Work') && !openedHITs.includes(workBtn.href)) {
                        
                        openedHITs.push(workBtn.href);
                        if (openedHITs.length > 50) openedHITs.shift(); 
                        sessionStorage.setItem('ben_opened_hits', JSON.stringify(openedHITs));

                        GM_openInTab(workBtn.href, { active: false, insert: true });
                        console.log("✅ Opened Ben Peterson HIT in background.");
                    }
                }
            });
        }, 2000);
        return; 
    }

    // ==========================================
    // সেকশন ৩: রেটিং, ম্যানুয়াল রিভিউ এবং রিলোড প্রোটোকল
    // ==========================================
    if (currentUrl.includes("photofeeler.com") || currentUrl.includes("mturkcontent.com") || document.querySelector('img:not([src*=".svg"])')) {
        
        const MODELS_TO_TEST = ["gemini-flash-lite-latest", "gemini-1.5-flash"];

        let hitCount = parseInt(localStorage.getItem('ben_hit_count') || '0');
        let nextTarget = parseInt(localStorage.getItem('ben_note_target') || '0');

        if (nextTarget === 0) {
            nextTarget = Math.floor(Math.random() * (15 - 6 + 1)) + 6; 
            localStorage.setItem('ben_note_target', nextTarget.toString());
        }

        hitCount++;
        let shouldWriteNote = false;

        if (hitCount >= nextTarget) {
            shouldWriteNote = true;
            localStorage.setItem('ben_hit_count', '0');
            localStorage.setItem('ben_note_target', '0');
            console.log(`🎯 Target reached! Scheduled to write a random comment this time.`);
        } else {
            localStorage.setItem('ben_hit_count', hitCount.toString());
            console.log(`🤫 No random comment scheduled. (HIT ${hitCount} of ${nextTarget})`);
        }

        // 🔴 ফিক্স: স্ক্রিপ্ট হ্যাং হলে ভুলভাল সাবমিট না করে পেজ রিলোড করবে
        function forceReloadPage() {
            console.log("⚠️ Error or Freeze Detected! Reloading page to get a fresh HIT...");
            setTimeout(() => window.location.reload(), 2000);
        }

        function callGeminiAPI(modelName, payload) {
            return new Promise((resolve) => {
                const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${API_KEY}`;
                GM_xmlhttpRequest({
                    method: "POST",
                    url: API_URL,
                    headers: { "Content-Type": "application/json" },
                    data: JSON.stringify(payload),
                    timeout: 15000,
                    onload: (res) => {
                        try {
                            const responseJSON = JSON.parse(res.responseText);
                            if (responseJSON.error) resolve({ success: false, model: modelName, error: responseJSON.error.message });
                            else resolve({ success: true, model: modelName, data: responseJSON });
                        } catch (e) { resolve({ success: false, model: modelName, error: "Parse Error" }); }
                    },
                    onerror: () => resolve({ success: false, model: modelName, error: "Network Error" }),
                    ontimeout: () => resolve({ success: false, model: modelName, error: "Timeout Error" })
                });
            });
        }

        async function processHIT() {
            const img = document.querySelector('img:not([src*=".svg"]):not([src*="chrome-extension"])'); 
            if (!img) return;
            
            console.log("Image found! Downloading...");
            GM_xmlhttpRequest({
                method: 'GET',
                url: img.src,
                responseType: 'arraybuffer',
                timeout: 10000,
                onload: async function(response) {
                    if (response.status !== 200) {
                        console.error("🚨 Image download failed!");
                        forceReloadPage();
                        return;
                    }
                    try {
                        const bytes = new Uint8Array(response.response);
                        let binary = '';
                        for (let i = 0; i < bytes.length; i += 8192) {
                            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
                        }
                        await getRatingFromGemini(window.btoa(binary));
                    } catch (err) { 
                        console.error("Conversion Error", err); 
                        forceReloadPage();
                    }
                },
                onerror: function(err) {
                    console.error("🚨 Image network error", err);
                    forceReloadPage();
                },
                ontimeout: function() {
                    console.error("🚨 Image download timeout");
                    forceReloadPage();
                }
            });
        }

        async function getRatingFromGemini(base64Image) {
            const payload = {
                contents: [{
                    parts: [
                        { text: `Rate dating photo. AVOID BOT BEHAVIOR. 1. NEVER give same scores (e.g. 3,3,3). 2. Rate 0-3 separately per trait. Be strict, use 0/1 often. 3. Return ONLY JSON: acceptable (bool, false if meme/no person), smart (0-3), trustworthy (0-3), attractive (0-3). 5. "note": string (ALWAYS write a very short, realistic 1 to 3 word compliment just in case it's needed).` },
                        { inline_data: { mime_type: "image/jpeg", data: base64Image } }
                    ]
                }],
                generationConfig: { responseMimeType: "application/json", temperature: 0.7 }
            };

            for (let model of MODELS_TO_TEST) {
                const result = await callGeminiAPI(model, payload);
                if (result.success) {
                    try {
                        let rawText = result.data.candidates[0].content.parts[0].text;
                        let cleanText = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
                        let parsedData = JSON.parse(cleanText);
                        applyToForm(parsedData, false);
                        return;
                    } catch (parseErr) {
                        console.error("🚨 AI JSON Parse Error:", parseErr);
                    }
                }
            }
            console.error("🚨 All AI models failed!");
            forceReloadPage();
        }

        let currentMousePos = { x: window.innerWidth / 2, y: window.innerHeight / 2 };

        async function simulateHumanMouseClick(element) {
            const rect = element.getBoundingClientRect();
            const targetX = rect.left + (rect.width * 0.2) + (Math.random() * rect.width * 0.6);
            const targetY = rect.top + (rect.height * 0.2) + (Math.random() * rect.height * 0.6);
            
            const steps = Math.floor(Math.random() * 15) + 15; 
            
            for (let i = 1; i <= steps; i++) {
                const t = i / steps;
                const easeT = t * (2 - t); 
                const x = currentMousePos.x + (targetX - currentMousePos.x) * easeT;
                const y = currentMousePos.y + (targetY - currentMousePos.y) * easeT;
                element.ownerDocument.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
                await new Promise(r => setTimeout(r, Math.floor(Math.random() * 20) + 15));
            }

            currentMousePos.x = targetX;
            currentMousePos.y = targetY;
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
                
                if (document.hidden) {
                    const rect = element.getBoundingClientRect();
                    const targetX = rect.left + (rect.width * 0.2) + (Math.random() * rect.width * 0.6);
                    const targetY = rect.top + (rect.height * 0.2) + (Math.random() * rect.height * 0.6);

                    element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: targetX, clientY: targetY }));
                    element.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, clientX: targetX, clientY: targetY }));
                    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: targetX, clientY: targetY }));
                    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: targetX, clientY: targetY }));
                    element.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: targetX, clientY: targetY }));
                    
                    if (element.parentElement) element.parentElement.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: targetX, clientY: targetY }));
                    let hiddenInput = element.querySelector('input');
                    if (hiddenInput) hiddenInput.click();
                } else {
                    await simulateHumanMouseClick(element);
                }
                return true;
            }
            return false;
        }

        function applyToForm(data, forceNote) {
            const startDelay = Math.floor(Math.random() * 2000) + 2000;
            const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

            setTimeout(async () => {
                try {
                    let acceptText = data.acceptable ? "Yes" : "No";
                    await forceClickExactText(acceptText, 0); 

                    // 🔴 ফিক্স: যদি এআই 'No' সিলেক্ট করে, তবে এখানেই কাজ থামিয়ে দেবে (ম্যানুয়াল রিভিউর জন্য)
                    if (!data.acceptable) {
                        console.log("🛑 AI evaluated this as 'No'. Stopping auto-submit for manual review.");
                        return; // কোডটি আর নিচে যাবে না! সাবমিট আপনার জন্য অপেক্ষা করবে।
                    }

                    await sleep(Math.floor(Math.random() * 800) + 500); 
                    const textMap = { 3: "3 Very", 2: "2 Yes", 1: "1 Somewhat", 0: "0 No" };
                    
                    const clickScore = async (trait, score) => {
                        const traitIndex = { 'smart': 0, 'trustworthy': 1, 'attractive': 2 }[trait];
                        await forceClickExactText(textMap[score], traitIndex);
                    };

                    await clickScore('smart', data.smart);
                    await sleep(Math.floor(Math.random() * 800) + 600); 
                    
                    await clickScore('trustworthy', data.trustworthy);
                    await sleep(Math.floor(Math.random() * 800) + 600); 
                    
                    await clickScore('attractive', data.attractive);
                    await sleep(Math.floor(Math.random() * 800) + 600); 

                    const allElements = Array.from(document.body.querySelectorAll('*'));
                    let skipExists = allElements.filter(el => {
                        if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') return false;
                        return el.textContent.replace(/\s+/g, ' ').trim() === 'Skip';
                    }).filter((el, index, arr) => !arr.some(otherEl => el !== otherEl && el.contains(otherEl))).length > 0;

                    if (skipExists) {
                        console.log("⚠️ 'Skip' detected AFTER rating! Forcing comment to reveal 'Submit'.");
                    }

                    if (shouldWriteNote || skipExists || forceNote) {
                        let fallbackNote = (data.note && data.note.trim() !== "") ? data.note : "Great photo";
                        let textarea = document.querySelector('textarea');
                        if (textarea) {
                            textarea.value = fallbackNote;
                            textarea.dispatchEvent(new Event('input', { bubbles: true }));
                            textarea.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                        await sleep(Math.floor(Math.random() * 800) + 500); 
                    }
                    
                    const submitDelay = Math.floor(Math.random() * 2000) + 1500; 
                    setTimeout(async () => {
                        // ব্রাউজারকে জানিয়ে রাখা হলো যে কাজ সাবমিট হচ্ছে, যেন এরপর সে ট্যাব কেটে দেয়
                        sessionStorage.setItem('ben_just_submitted', 'true');
                        await forceClickExactText('Submit', 0);
                    }, submitDelay);
                    
                } catch (err) { 
                    console.error("Error in form:", err); 
                    forceReloadPage();
                }
            }, startDelay);
        }

        setTimeout(processHIT, 1000);
    }
})();
