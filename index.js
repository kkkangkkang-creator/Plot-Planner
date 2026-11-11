// Plot Planner — generate several outlines for the next reply, let the user edit/pick one,
// then send it as a one-reply injection. The chosen plot stays attached to that reply slot,
// so a failed generation (429 etc.) can simply be retried / swiped with the same plot.

const MODULE = 'plot_planner';
const INJECT_KEY = 'plot_planner_inject';

const DEFAULT_PLANNER_PROMPT = `[다음 답변 개요 설계]
지금은 본문을 쓰지 않는다. 위 대화에 이어질 다음 답변 한 편의 개요를 {{count}}개 짠다.

- 개요끼리는 지금 장면 안에서 서로 다른 갈림길을 간다. 갈림길은 누가 먼저 움직이는지, 무엇이 드러나거나 숨겨지는지, 인물의 감정과 판단이 어느 쪽으로 기우는지에서 나온다. 장면을 바꾸거나 새 사건을 끌어들이는 걸로 차이를 만들지 않는다.
- 설정은 이번 답변에 실제로 쓰이는 것만 고르고, 왜 필요한지 적는다. 쓸 설정이 없으면 비워 둔다.
- {{user}}의 행동·대사·생각은 정하지 않는다.
- 비트는 답변 한 편 분량에 맞게 2~4개로 짠다.
- 끝나는 지점은 답변의 마지막 장면이나 대사를 구체적으로 적는다.

아래 형식만 출력한다.
<plot>
<title>한 줄 요약</title>
<beats>
- 비트
</beats>
<lore>
- 설정: 필요한 이유
</lore>
<ending>끝나는 지점</ending>
</plot>`;

const DEFAULT_INJECT_TEMPLATE = `[이번 답변 개요]
이번 답변은 아래 개요를 따라 쓴다. 비트를 순서대로 장면으로 풀어 쓰고, 끝나는 지점에서 답변을 끝낸다. 개요의 설정 외에 다른 설정을 새로 끌어오지 않는다.

{{plot}}`;

const defaultSettings = Object.freeze({
    profileId: '',          // '' = current connection
    count: 3,
    mode: 'single',         // 'single' | 'sequential'
    maxTokens: 8000,
    temperature: '',        // '' = preset value (profile only)
    depth: 0,
    role: 0,                // 0 system, 1 user, 2 assistant
    plannerPrompt: DEFAULT_PLANNER_PROMPT,
    injectTemplate: DEFAULT_INJECT_TEMPLATE,
});

// ---------- settings / state ----------

function ctx() {
    return SillyTavern.getContext();
}

function getSettings() {
    const { extensionSettings } = ctx();
    if (!extensionSettings[MODULE]) {
        extensionSettings[MODULE] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(extensionSettings[MODULE], key)) {
            extensionSettings[MODULE][key] = defaultSettings[key];
        }
    }
    return extensionSettings[MODULE];
}

// Per-chat data: { plots: string[], selected: number, active: { text, userCount } | null }
function getMeta() {
    const { chatMetadata } = ctx();
    if (!chatMetadata[MODULE]) {
        chatMetadata[MODULE] = { plots: [], selected: 0, active: null };
    }
    return chatMetadata[MODULE];
}

function saveMeta() {
    ctx().saveMetadataDebounced();
}

function countUserMessages() {
    return ctx().chat.filter(m => m.is_user && !m.is_system).length;
}

// ---------- injection (one reply slot) ----------

function clearInjection() {
    const c = ctx();
    c.setExtensionPrompt(INJECT_KEY, '', 1, 0);
}

function buildInjection(plotText) {
    const s = getSettings();
    const body = s.injectTemplate.includes('{{plot}}')
        ? s.injectTemplate.replace('{{plot}}', plotText)
        : `${s.injectTemplate}\n\n${plotText}`;
    return ctx().substituteParams(body);
}

// Runs right before every real (non-dry) generation.
globalThis.plotPlannerInterceptor = async function (_chat, _contextSize, _abort, type) {
    clearInjection();
    if (!ctx().chatMetadata) return;
    const meta = getMeta();
    if (!meta.active) return;
    if (type === 'quiet' || type === 'impersonate') return;

    const users = countUserMessages();
    if (users === meta.active.userCount) {
        const s = getSettings();
        ctx().setExtensionPrompt(INJECT_KEY, buildInjection(meta.active.text), 1, Number(s.depth), false, Number(s.role));
    } else if (users > meta.active.userCount) {
        // The conversation moved past the planned reply — drop the plot.
        meta.active = null;
        saveMeta();
        updateButtonState();
    }
};

// ---------- prompt capture & request ----------

let planning = false;
let abortCtrl = null;

async function capturePrompt() {
    const c = ctx();
    let captured = null;
    const handler = (data, dryRun) => {
        if (dryRun && captured === null) captured = data?.prompt ?? null;
    };
    clearInjection();
    c.eventSource.on(c.event_types.GENERATE_AFTER_DATA, handler);
    try {
        await c.generate('normal', {}, true);
    } finally {
        c.eventSource.removeListener(c.event_types.GENERATE_AFTER_DATA, handler);
    }
    if (captured === null) throw new Error('현재 프롬프트를 가져오지 못했어요.');
    if (typeof captured === 'string') return [{ role: 'user', content: captured }];
    return structuredClone(captured);
}

function buildPlannerMessages(base, input, count, exclude) {
    const s = getSettings();
    const c = ctx();
    const messages = base.slice();
    if (input) messages.push({ role: 'user', content: input });

    let instruction = c.substituteParams(s.plannerPrompt.replaceAll('{{count}}', String(count)));
    if (exclude.length) {
        const list = exclude.map((p, i) => `(${i + 1})\n${p}`).join('\n\n');
        instruction += `\n\n[이미 나온 개요]\n${list}\n\n위 개요들과 갈림길이 겹치지 않는 개요를 짠다.`;
    }
    messages.push({ role: 'user', content: instruction });
    return messages;
}

function errorText(e) {
    const parts = [];
    let cur = e;
    while (cur) {
        if (cur.message && !parts.includes(cur.message)) parts.push(cur.message);
        cur = cur.cause;
    }
    if (!parts.length && e) parts.push(String(e));
    return parts.join(' — ');
}

async function requestPlans(messages) {
    const s = getSettings();
    const c = ctx();

    if (s.profileId) {
        const svc = c.ConnectionManagerRequestService;
        const override = {};
        const t = String(s.temperature).trim();
        if (t !== '' && !Number.isNaN(Number(t))) override.temperature = Number(t);
        const prompt = svc.constructPrompt(messages, s.profileId);
        const res = await svc.sendRequest(
            s.profileId, prompt, Number(s.maxTokens) || 8000,
            { stream: false, signal: abortCtrl?.signal, extractData: true, includePreset: true, includeInstruct: true },
            override,
        );
        return typeof res === 'string' ? res : (res?.content ?? '');
    }

    return await c.generateRaw({ prompt: messages, responseLength: Number(s.maxTokens) || null });
}

function tag(src, name) {
    const m = src.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i'));
    return m ? m[1].trim() : '';
}

function parsePlots(raw) {
    const text = String(raw ?? '').replace(/<think(ing)?>[\s\S]*?<\/think(ing)?>/gi, '');
    const blocks = [...text.matchAll(/<plot>([\s\S]*?)<\/plot>/gi)].map(m => m[1]);
    if (!blocks.length) {
        const t = text.trim();
        return t ? [t] : [];
    }
    return blocks.map(b => {
        const title = tag(b, 'title');
        const beats = tag(b, 'beats');
        const lore = tag(b, 'lore');
        const ending = tag(b, 'ending');
        if (!title && !beats && !ending) return b.trim();
        return [
            title,
            beats && `전개\n${beats}`,
            `설정\n${lore || '- 없음'}`,
            ending && `끝\n${ending}`,
        ].filter(Boolean).join('\n\n');
    });
}

// ---------- planning flow ----------

let lastAction = 'new';

async function runPlanning(append) {
    if (planning) return;
    const textarea = document.getElementById('send_textarea');
    const input = String(textarea?.value ?? '').trim();
    if (input.startsWith('/')) {
        toastr.warning('슬래시 커맨드 입력에는 쓸 수 없어요.');
        return;
    }

    const s = getSettings();
    const meta = getMeta();
    const count = Math.max(1, Math.min(8, Number(s.count) || 3));
    lastAction = append ? 'more' : 'new';

    planning = true;
    abortCtrl = new AbortController();
    setStatus('프롬프트 확인 중…', 'busy');
    renderPlots();
    renderButtons();

    const existing = append ? meta.plots.slice() : [];
    const fresh = [];

    try {
        const base = await capturePrompt();

        if (s.mode === 'sequential') {
            for (let i = 0; i < count; i++) {
                setStatus(`개요 생성 중… (${i + 1}/${count})`, 'busy');
                const raw = await requestPlans(buildPlannerMessages(base, input, 1, [...existing, ...fresh]));
                const got = parsePlots(raw);
                if (!got.length) throw new Error('빈 응답이 왔어요.');
                fresh.push(got[0]);
                commitPlots(append, existing, fresh);
            }
        } else {
            setStatus('개요 생성 중…', 'busy');
            const raw = await requestPlans(buildPlannerMessages(base, input, count, existing));
            const got = parsePlots(raw);
            if (!got.length) throw new Error('빈 응답이 왔어요.');
            fresh.push(...got);
            commitPlots(append, existing, fresh);
        }
        setStatus(`${fresh.length}개 생성됨`, '');
    } catch (e) {
        console.error(`[${MODULE}]`, e);
        if (fresh.length) {
            commitPlots(append, existing, fresh);
            lastAction = 'more'; // retry keeps what already came back
        }
        const aborted = abortCtrl?.signal.aborted;
        setStatus(aborted ? '취소됨' : `생성 실패: ${errorText(e)}`, aborted ? '' : 'error');
    } finally {
        planning = false;
        abortCtrl = null;
        renderButtons();
    }
}

function commitPlots(append, existing, fresh) {
    const meta = getMeta();
    meta.plots = append ? [...existing, ...fresh] : fresh.slice();
    if (!append) meta.selected = 0;
    if (meta.selected >= meta.plots.length) meta.selected = 0;
    saveMeta();
    renderPlots();
}

function cancelPlanning() {
    abortCtrl?.abort();
    if (!getSettings().profileId) ctx().stopGeneration();
}

function sendSelected() {
    const meta = getMeta();
    const text = (meta.plots[meta.selected] ?? '').trim();
    if (!text) {
        toastr.warning('보낼 개요가 비어 있어요.');
        return;
    }
    const sendBtn = document.getElementById('send_but');
    if (!sendBtn || sendBtn.classList.contains('displayNone')) {
        toastr.warning('지금은 보낼 수 없어요. 생성이 끝난 뒤 다시 눌러 주세요.');
        return;
    }
    const input = String(document.getElementById('send_textarea')?.value ?? '').trim();
    meta.active = { text, userCount: countUserMessages() + (input ? 1 : 0) };
    saveMeta();
    updateButtonState();
    closePanel();
    sendBtn.click();
}

function releaseActive() {
    const meta = getMeta();
    meta.active = null;
    saveMeta();
    clearInjection();
    updateButtonState();
    renderActive();
}

// ---------- UI: input button ----------

function addInputButton() {
    if (document.getElementById('plot_planner_btn')) return;
    const sendBtn = document.getElementById('send_but');
    if (!sendBtn) return;
    const btn = document.createElement('div');
    btn.id = 'plot_planner_btn';
    btn.className = 'fa-solid fa-code-branch interactable';
    btn.title = '다음 장면 개요';
    btn.tabIndex = 0;
    btn.addEventListener('click', openPanel);
    sendBtn.parentElement.insertBefore(btn, sendBtn);
}

function updateButtonState() {
    const btn = document.getElementById('plot_planner_btn');
    if (!btn) return;
    const active = !!ctx().chatMetadata?.[MODULE]?.active;
    btn.classList.toggle('pp-armed', active);
    btn.title = active ? '다음 장면 개요 (적용 중)' : '다음 장면 개요';
}

// ---------- UI: panel ----------

let panel = null;

function openPanel() {
    if (!panel) buildPanel();
    document.activeElement?.blur?.();
    if (!panel.open) panel.showModal();
    renderActive();
    renderPlots();
    renderButtons();
    if (!planning && !getMeta().plots.length) runPlanning(false);
}

function closePanel() {
    if (panel?.open) panel.close();
}

function buildPanel() {
    // <dialog> renders in the browser top layer, so theme/mobile layouts can't push it off-screen.
    panel = document.createElement('dialog');
    panel.id = 'plot_planner_overlay';
    panel.innerHTML = `
        <div class="pp-sheet" role="dialog" aria-label="다음 장면 개요">
            <div class="pp-head">
                <span class="pp-title">다음 장면 개요</span>
                <span class="pp-status"></span>
                <span class="pp-close fa-solid fa-xmark" title="닫기"></span>
            </div>
            <div class="pp-active"></div>
            <div class="pp-list"></div>
            <div class="pp-foot">
                <button type="button" class="pp-btn" data-act="new">새로 생성</button>
                <button type="button" class="pp-btn" data-act="more">더 보기</button>
                <button type="button" class="pp-btn" data-act="retry">다시 시도</button>
                <button type="button" class="pp-btn" data-act="cancel">취소</button>
                <span class="pp-spacer"></span>
                <button type="button" class="pp-btn pp-primary" data-act="send">이 개요로 전송</button>
            </div>
        </div>`;
    document.body.appendChild(panel);

    panel.addEventListener('click', (e) => {
        if (e.target === panel) closePanel();
    });
    panel.querySelector('.pp-close').addEventListener('click', closePanel);
    panel.querySelector('.pp-foot').addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'new') runPlanning(false);
        else if (act === 'more') runPlanning(true);
        else if (act === 'retry') runPlanning(lastAction === 'more');
        else if (act === 'cancel') cancelPlanning();
        else if (act === 'send') sendSelected();
    });
}

function setStatus(text, kind) {
    if (!panel) buildPanel();
    const el = panel.querySelector('.pp-status');
    el.textContent = text;
    el.dataset.kind = kind || '';
}

function renderButtons() {
    if (!panel) return;
    const meta = getMeta();
    const failed = panel.querySelector('.pp-status').dataset.kind === 'error';
    const show = (act, on) => panel.querySelector(`[data-act="${act}"]`).hidden = !on;
    show('new', !planning);
    show('more', !planning && meta.plots.length > 0);
    show('retry', !planning && failed);
    show('cancel', planning);
    show('send', !planning && meta.plots.length > 0);
}

function autosize(ta) {
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight + 2}px`;
}

function renderPlots() {
    if (!panel) return;
    const meta = getMeta();
    const list = panel.querySelector('.pp-list');
    list.textContent = '';

    if (!meta.plots.length) {
        const empty = document.createElement('div');
        empty.className = 'pp-empty';
        empty.textContent = planning ? '생성 중…' : '아직 개요가 없어요.';
        list.appendChild(empty);
        return;
    }

    meta.plots.forEach((text, i) => {
        const row = document.createElement('div');
        row.className = 'pp-plot' + (i === meta.selected ? ' selected' : '');

        const num = document.createElement('div');
        num.className = 'pp-num';
        num.textContent = String(i + 1);
        num.title = '이 개요 선택';

        const ta = document.createElement('textarea');
        ta.className = 'pp-text';
        ta.value = text;
        ta.spellcheck = false;
        ta.addEventListener('input', () => {
            getMeta().plots[i] = ta.value;
            saveMeta();
            autosize(ta);
        });

        const del = document.createElement('div');
        del.className = 'pp-del fa-solid fa-trash-can';
        del.title = '삭제';
        del.addEventListener('click', (e) => {
            e.stopPropagation();
            const m = getMeta();
            m.plots.splice(i, 1);
            if (m.selected >= m.plots.length) m.selected = Math.max(0, m.plots.length - 1);
            saveMeta();
            renderPlots();
            renderButtons();
        });

        const select = () => {
            if (getMeta().selected === i) return;
            getMeta().selected = i;
            saveMeta();
            list.querySelectorAll('.pp-plot').forEach((el, j) => el.classList.toggle('selected', j === i));
        };
        num.addEventListener('click', select);
        ta.addEventListener('focus', select);

        row.append(num, ta, del);
        list.appendChild(row);
        requestAnimationFrame(() => autosize(ta));
    });
}

function renderActive() {
    if (!panel) return;
    const el = panel.querySelector('.pp-active');
    const active = getMeta().active;
    el.textContent = '';
    if (!active) {
        el.hidden = true;
        return;
    }
    el.hidden = false;
    const label = document.createElement('span');
    const first = active.text.split('\n').find(l => l.trim()) ?? '';
    label.textContent = `적용 중 · ${first}`;
    label.title = '실패하면 그냥 다시 생성/스와이프해도 이 개요가 다시 들어가요.';
    const off = document.createElement('button');
    off.type = 'button';
    off.className = 'pp-btn';
    off.textContent = '해제';
    off.addEventListener('click', releaseActive);
    el.append(label, off);
}

// ---------- UI: settings drawer ----------

function buildSettings() {
    const s = getSettings();
    const html = `
    <div id="plot_planner_settings" class="extension_settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Plot Planner</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="pp-settings">
                <label>개요 생성 연결 프로필
                    <select id="pp_profile" class="text_pole"></select>
                </label>
                <div class="pp-row">
                    <label>개수 <input id="pp_count" class="text_pole" type="number" min="1" max="8"></label>
                    <label>방식
                        <select id="pp_mode" class="text_pole">
                            <option value="single">한 번에</option>
                            <option value="sequential">하나씩</option>
                        </select>
                    </label>
                </div>
                <div class="pp-row">
                    <label>최대 토큰 <input id="pp_max" class="text_pole" type="number" min="100" step="100"></label>
                    <label>온도 <input id="pp_temp" class="text_pole" type="text" placeholder="프리셋값"></label>
                </div>
                <div class="pp-row">
                    <label>주입 깊이 <input id="pp_depth" class="text_pole" type="number" min="0"></label>
                    <label>주입 역할
                        <select id="pp_role" class="text_pole">
                            <option value="0">system</option>
                            <option value="1">user</option>
                            <option value="2">assistant</option>
                        </select>
                    </label>
                </div>
                <small class="pp-hint">온도는 연결 프로필을 골랐을 때만 적용돼요. '하나씩'은 앞 개요와 겹치지 않게 한 개씩 뽑아서 더 다양하지만 호출이 개수만큼 나가요.</small>
                <label>개요 생성 지침 <small>{{count}} = 개수</small>
                    <textarea id="pp_planner" class="text_pole" rows="10"></textarea>
                </label>
                <label>주입 템플릿 <small>{{plot}} = 고른 개요</small>
                    <textarea id="pp_inject" class="text_pole" rows="5"></textarea>
                </label>
                <div class="pp-row">
                    <button type="button" id="pp_reset" class="menu_button">지침 기본값으로</button>
                </div>
                </div>
            </div>
        </div>
    </div>`;
    document.getElementById('extensions_settings2').insertAdjacentHTML('beforeend', html);

    const $ = (id) => document.getElementById(id);
    const save = () => ctx().saveSettingsDebounced();

    const fillProfiles = () => {
        const sel = $('pp_profile');
        const cur = getSettings().profileId;
        sel.textContent = '';
        sel.add(new Option('현재 연결 사용', ''));
        try {
            for (const p of ctx().ConnectionManagerRequestService.getSupportedProfiles()) {
                sel.add(new Option(p.name, p.id));
            }
        } catch { /* connection manager disabled */ }
        sel.value = cur;
        if (sel.value !== cur) sel.value = '';
    };
    fillProfiles();
    $('pp_profile').addEventListener('focus', fillProfiles);
    $('pp_profile').addEventListener('change', (e) => { getSettings().profileId = e.target.value; save(); });

    const bind = (id, key, cast = (v) => v) => {
        const el = $(id);
        el.value = s[key];
        el.addEventListener('input', () => { getSettings()[key] = cast(el.value); save(); });
    };
    bind('pp_count', 'count', Number);
    bind('pp_mode', 'mode');
    bind('pp_max', 'maxTokens', Number);
    bind('pp_temp', 'temperature');
    bind('pp_depth', 'depth', Number);
    bind('pp_role', 'role', Number);
    bind('pp_planner', 'plannerPrompt');
    bind('pp_inject', 'injectTemplate');
    $('pp_mode').addEventListener('change', (e) => { getSettings().mode = e.target.value; save(); });
    $('pp_role').addEventListener('change', (e) => { getSettings().role = Number(e.target.value); save(); });

    $('pp_reset').addEventListener('click', () => {
        const st = getSettings();
        st.plannerPrompt = DEFAULT_PLANNER_PROMPT;
        st.injectTemplate = DEFAULT_INJECT_TEMPLATE;
        $('pp_planner').value = st.plannerPrompt;
        $('pp_inject').value = st.injectTemplate;
        save();
    });
}

// ---------- init ----------

(function init() {
    const c = ctx();
    getSettings();

    const clear = () => clearInjection();
    c.eventSource.on(c.event_types.GENERATION_ENDED, clear);
    c.eventSource.on(c.event_types.GENERATION_STOPPED, clear);

    c.eventSource.on(c.event_types.CHAT_CHANGED, () => {
        closePanel();
        clearInjection();
        updateButtonState();
    });

    c.eventSource.on(c.event_types.APP_READY, () => {
        buildSettings();
        addInputButton();
        updateButtonState();
    });
})();
