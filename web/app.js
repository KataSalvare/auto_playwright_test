(() => {
  'use strict';

  const config = window.TEST_CONFIG || {};
  const requiredKeys = (config.parameters || []).filter((item) => item.group === 'required').map((item) => item.key);
  const optionalKeys = (config.parameters || []).filter((item) => item.group === 'optional').map((item) => item.key);
  const state = { mode: 'auto', presetId: config.presets?.[0]?.id || '', currentUrl: '', validation: null, runs: [], run: null };
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];

  function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }
  function randomDigits(length) { let output = ''; for (let index = 0; index < length; index += 1) output += Math.floor(Math.random() * 10); return output; }
  function createIdentityNumber() { const identityNumbers = config.defaults?.identityNumbers || ['320381198812252138']; return identityNumbers[Math.floor(Math.random() * identityNumbers.length)]; }
  function createOrderId() { return `${config.defaults?.orderIdPrefix || 'QA'}${Date.now().toString().slice(-8)}`; }
  function createPhone() { return `${config.defaults?.phonePrefix || '159'}${randomDigits(8)}`; }
  function defaultName() { const names = config.defaults?.names || ['测试用户']; return names[Math.floor(Math.random() * names.length)]; }
  function currentPreset() { return (config.presets || []).find((preset) => preset.id === state.presetId) || config.presets?.[0] || {}; }
  function setInput(id, value) { const element = $(`#${id}`); if (element) element.value = value ?? ''; }
  function getInput(id) { return $(`#${id}`)?.value.trim() || ''; }
  function showToast(message) { const toast = $('#toast'); toast.textContent = message; toast.classList.add('is-visible'); window.clearTimeout(showToast.timer); showToast.timer = window.setTimeout(() => toast.classList.remove('is-visible'), 2400); }
  function delay(milliseconds) { return new Promise((resolve) => window.setTimeout(resolve, milliseconds)); }
  function ensureAdvancedModal() { const fields = $('#advancedFields'); const modalBody = $('#advancedModalBody'); if (fields && modalBody && fields.parentElement !== modalBody) modalBody.append(fields); }

  function initialize() {
    $('[data-app-name]').textContent = config.appName || '快速测试控制台';
    $$('[data-app-version]').forEach((element) => { element.textContent = config.appVersion || 'local'; });
    renderPresets(); renderParameterTable(); ensureAdvancedModal(); resetForm(); bindEvents(); updatePlanPreview(); restoreRun();
  }

  function renderPresets() {
    $('#presetList').innerHTML = (config.presets || []).map((preset) => `<button class="preset-option${preset.id === state.presetId ? ' is-selected' : ''}" type="button" data-preset="${escapeHtml(preset.id)}"><span class="preset-radio" aria-hidden="true"></span><span class="preset-name">${escapeHtml(preset.label)}</span><span class="preset-description">${escapeHtml(preset.description)}</span><span class="preset-id">${escapeHtml(preset.id)}</span></button>`).join('');
    $$('.preset-option').forEach((button) => button.addEventListener('click', () => selectPreset(button.dataset.preset)));
  }
  function selectPreset(presetId) { state.presetId = presetId; const preset = currentPreset(); setInput('pageOrder', preset.pageOrder ?? config.defaults?.pageOrder ?? '1'); setInput('socialSecurity', preset.socialSecurity ?? config.defaults?.socialSecurity ?? '1'); setInput('autoRenewal', preset.autoRenewal ?? config.defaults?.autoRenewal ?? '1'); setInput('shangdan', preset.extraParams?.shangdan ?? config.defaults?.shangdan ?? ''); renderPresets(); }
  function renderParameterTable() { $('#parameterTable').innerHTML = (config.parameters || []).map((item) => `<tr><td>${escapeHtml(item.key)}</td><td>${escapeHtml(item.label)}</td><td><span class="param-type ${item.group === 'required' ? 'required' : ''}">${item.group === 'required' ? 'REQUIRED' : 'OPTIONAL'}</span></td><td>${escapeHtml(item.description)}</td><td><span class="param-status">●</span></td></tr>`).join(''); }

  function normalizeRun(payload, fallback = {}) {
    return { ...fallback, runId: payload.runId || fallback.runId || '', targetUrl: payload.targetUrl || fallback.targetUrl || '', total: payload.total ?? fallback.total ?? 0, concurrency: payload.concurrency ?? fallback.concurrency ?? 1, completed: payload.completedCount ?? fallback.completed ?? 0, success: payload.success ?? fallback.success ?? 0, failed: payload.failed ?? fallback.failed ?? 0, startedAt: payload.startedAt || fallback.startedAt || Date.now(), completedAt: payload.completedAt || fallback.completedAt || null, status: payload.status || fallback.status || 'completed', results: (payload.results || fallback.results || []).map((item) => ({ ...item, status: item.status || (item.successful ? 'success' : 'failed'), successful: Boolean(item.successful), duration: item.duration || '—', videoUrl: item.videoUrl || '', error: item.error || '' })) };
  }
  function replaceHistoryRuns(payloadRuns) { state.runs = payloadRuns.map((payload) => normalizeRun(payload)); state.run = state.runs[0] || null; }
  async function restoreRun() {
    let savedRuns;
    try {
      const response = await fetch('/api/quick-test/runs', { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || '无法读取服务器测试记录');
      savedRuns = Array.isArray(payload.runs) ? payload.runs : [];
    } catch {
      return;
    }
    if (!savedRuns.length || state.run) return;
    replaceHistoryRuns(savedRuns);
    state.currentUrl = state.run?.targetUrl || '';
    if (state.currentUrl) {
      try { validateAndRender(state.currentUrl, '已恢复上次链接'); } catch { state.validation = null; }
    }
    $('#resultsEmpty').hidden = true; $('#resultsContent').hidden = false; $('#step4').classList.remove('is-locked');
    setWorkflowStep(4); renderRun();
    if (state.run?.completedAt) {
      $('#runProgress').hidden = true; $('#runAgainButton').disabled = false;
      setRunStatus(state.run.failed ? 'error' : 'success', state.run.failed ? '部分失败' : '全部成功');
      return;
    }
    $('#runProgress').hidden = false; $('#runAgainButton').disabled = true; setRunStatus('running', '恢复执行状态');
    pollRun(state.run.runId).then(() => {
      if (!state.run) return;
      $('#runProgress').hidden = true; $('#runAgainButton').disabled = false;
      setRunStatus(state.run.failed ? 'error' : 'success', state.run.failed ? '部分失败' : '全部成功'); renderRun();
    }).catch((error) => {
      if (!state.run) return;
      state.run.results = state.run.results.map((item) => item.status === 'queued' || item.status === 'running' ? { ...item, status: 'failed', error: '页面刷新后无法恢复脚本状态' } : item);
      state.run.failed = state.run.results.filter((item) => item.status === 'failed').length; state.run.completed = state.run.results.length; state.run.completedAt = Date.now();
      $('#runProgress').hidden = true; $('#runAgainButton').disabled = false; setRunStatus('error', '执行状态已失效'); renderRun(); showToast(error instanceof Error ? error.message : '执行状态已失效');
    });
  }

  function resetForm() {
    selectPreset(state.presetId || config.presets?.[0]?.id); setInput('testName', defaultName()); setInput('orderId', createOrderId()); setInput('phone', createPhone()); setInput('identityNumber', createIdentityNumber()); setInput('basePrice', config.defaults?.basePrice || '10.99'); setInput('upgradePrice', config.defaults?.upgradePrice || '99.9'); setInput('originalUrl', config.originalUrl || config.baseUrl || ''); setInput('shangdan', config.defaults?.shangdan || ''); setInput('outerid', config.defaults?.outerid || config.defaults?.source || ''); setInput('manualUrl', ''); setInput('testCount', '3'); setInput('concurrency', '1');
    const advancedFields = $('#advancedFields');
    if (advancedFields) advancedFields.hidden = true;
    $('#advancedToggle').setAttribute('aria-expanded', 'false'); state.currentUrl = ''; state.validation = null; state.parsedParams = {}; state.runs = []; state.run = null; clearValidation(); clearRun(); setWorkflowStep(1);
  }

  function buildParams() {
    const preset = currentPreset();
    const params = { dingdan: getInput('orderId') || createOrderId(), shouji: getInput('phone') || createPhone(), xingming: getInput('testName') || defaultName(), shenfen: getInput('identityNumber') || createIdentityNumber(), shebao: getInput('socialSecurity'), xubao: getInput('autoRenewal'), shunxu: getInput('pageOrder'), jichu: getInput('basePrice') || config.defaults?.basePrice || '', shengji: getInput('upgradePrice') || config.defaults?.upgradePrice || '', shangdan: getInput('shangdan') || config.defaults?.shangdan || preset.extraParams?.shangdan || '', outerid: getInput('outerid') || config.defaults?.outerid || config.defaults?.source || '', __test_env__: config.defaults?.testEnvironment || '1', ...((preset.extraParams && Object.fromEntries(Object.entries(preset.extraParams).filter(([key]) => key !== 'shangdan'))) || {}) };
    return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== ''));
  }
  function buildUrl(params) { const url = new URL(getInput('originalUrl') || config.originalUrl || config.baseUrl || window.location.href); Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value)); return url.toString(); }
  function validateParams(url) {
    const checks = requiredKeys.map((key) => { const value = url.searchParams.get(key) || ''; let valid = Boolean(value); if (key === 'shouji') valid = /^\d{6,20}$/.test(value); if (key === 'shenfen') valid = /^\d{17}[\dXx]$/.test(value); if (key === 'shebao' || key === 'xubao') valid = value === '0' || value === '1'; if (key === 'shunxu') valid = value === '1' || value === '2'; return { key, value, valid }; });
    return { checks, templateValid: url.href.includes('temp-lp-jing'), allValid: url.href.includes('temp-lp-jing') && checks.every((check) => check.valid) };
  }

  function validateAndRender(rawUrl, sourceLabel) {
    let url; try { url = new URL(rawUrl); } catch { clearValidation(); setResultStatus('error', '链接无效'); showToast('链接格式无效，请检查后重试'); return false; }
    const validation = validateParams(url); state.currentUrl = url.toString(); state.validation = validation; $('#validationEmpty').hidden = true; $('#validationContent').hidden = false; $('#urlBox').textContent = state.currentUrl; $('#resultHeadline').textContent = validation.allValid ? sourceLabel : '链接需要修正'; $('#resultSubline').textContent = validation.allValid ? '所有必要参数均已通过校验，可以配置测试执行' : '请根据下方提示修正失败项'; $('#resultTime').textContent = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); setResultStatus(validation.allValid ? 'success' : 'error', validation.allValid ? '校验通过' : '校验失败'); renderChecks(validation); setExecutionAvailability(validation.allValid); setWorkflowStep(state.run ? 4 : validation.allValid ? 3 : 2); return validation.allValid;
  }
  function setResultStatus(type, text) { const status = $('#resultStatus'); status.className = `result-status ${type === 'idle' ? '' : `is-${type}`}`; status.innerHTML = `<span class="status-dot"></span>${escapeHtml(text)}`; }
  function clearValidation() { $('#validationEmpty').hidden = false; $('#validationContent').hidden = true; setResultStatus('idle', '等待链接'); setExecutionAvailability(false); }
  function renderChecks(validation) { const failures = []; if (!validation.templateValid) failures.push({ label: '模板标识 temp-lp-jing', value: '缺失' }); validation.checks.filter((check) => !check.valid).forEach((check) => failures.push({ label: parameterLabel(check.key), value: check.value || '未填写' })); $('#checkList').innerHTML = failures.length ? failures.map((failure) => `<div class="check-row is-error"><span class="check-icon">!</span><span>${escapeHtml(failure.label)} · ${escapeHtml(failure.value)}</span><span class="check-status">ERROR</span></div>`).join('') : '<div class="check-empty">未发现失败项，链接规范校验通过。</div>'; $('#checkSummary').textContent = failures.length ? `${failures.length} 项失败` : '无失败项'; }
  function parameterLabel(key) { return config.parameters?.find((item) => item.key === key)?.label || key; }
  function setExecutionAvailability(enabled) { $('#step3').classList.toggle('is-locked', !enabled); $('#executionLocked').hidden = enabled; $('#executionContent').hidden = !enabled; $('#startTestButton').disabled = !enabled; if (!enabled && !state.run) $('#step4').classList.add('is-locked'); }
  function setWorkflowStep(activeStep) { $$('.flow-step').forEach((step) => { const number = Number(step.dataset.flowStep); step.classList.toggle('is-active', number === activeStep); step.classList.toggle('is-complete', number < activeStep); }); }

  function updatePlanPreview() { const count = clampNumber(getInput('testCount') || 3, 1, 50); const concurrency = clampNumber(getInput('concurrency') || 1, 1, 10); const batches = Math.ceil(count / concurrency); $('#testPlanPreview').textContent = `${count} 次测试 · ${concurrency} 路并发`; $('#testPlanEstimate').textContent = `预计分 ${batches} 批执行`; }
  function clampNumber(value, min, max) { return Math.min(max, Math.max(min, Number.parseInt(value, 10) || min)); }
  function normalizeNumberInput(id) { const input = $(`#${id}`); input.value = clampNumber(input.value, Number(input.min), Number(input.max)); updatePlanPreview(); }

  function createPendingResults(total) { return Array.from({ length: total }, (_, offset) => ({ index: offset + 1, status: 'queued', successful: false, duration: '—', videoUrl: '', error: '' })); }
  function applyRunPayload(payload) { const activeRunId = state.run?.runId || ''; const currentIndex = state.runs.findIndex((run) => run.runId === payload.runId); const pendingIndex = currentIndex < 0 && state.run && !state.run.runId ? state.runs.indexOf(state.run) : -1; const historyIndex = currentIndex >= 0 ? currentIndex : pendingIndex; const previous = historyIndex >= 0 ? state.runs[historyIndex] : {}; const next = normalizeRun(payload, previous); if (historyIndex >= 0) state.runs[historyIndex] = next; else state.runs.unshift(next); state.run = activeRunId && activeRunId !== next.runId ? state.runs.find((run) => run.runId === activeRunId) || next : next; }
  async function pollRun(runId) { while (state.run?.runId === runId && !state.run.completedAt) { await delay(500); const response = await fetch(`/api/quick-test/run/${encodeURIComponent(runId)}`); const payload = await response.json(); if (!response.ok) throw new Error(payload.error || '无法读取测试执行状态'); applyRunPayload(payload); renderRun(); if (payload.done) break; } }
  async function startTests() {
    if (!state.validation?.allValid) { showToast('请先通过链接规范校验'); return; }
    const total = clampNumber(getInput('testCount'), 1, 50); const concurrency = clampNumber(getInput('concurrency'), 1, 10); setInput('testCount', total); setInput('concurrency', concurrency); const pendingRun = { total, concurrency, completed: 0, success: 0, failed: 0, startedAt: Date.now(), completedAt: null, runId: '', targetUrl: state.currentUrl, status: 'running', results: createPendingResults(total) }; state.runs.unshift(pendingRun); state.run = pendingRun; $('#resultsEmpty').hidden = true; $('#resultsContent').hidden = false; $('#runProgress').hidden = false; $('#startTestButton').disabled = true; $('#runAgainButton').disabled = true; $('#step4').classList.remove('is-locked'); setRunStatus('running', '真实脚本执行中'); setWorkflowStep(4); renderRun();
    try {
      const response = await fetch('/api/quick-test/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: state.currentUrl, count: total, concurrency }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || '自动化脚本执行失败');
      applyRunPayload(payload); renderRun(); await pollRun(payload.runId);
      $('#runProgress').hidden = true; $('#runAgainButton').disabled = false; setRunStatus(state.run.failed ? 'error' : 'success', state.run.failed ? '部分失败' : '全部成功'); renderRun(); showToast(`测试完成：${state.run.success} 条成功，${state.run.failed} 条失败`);
    } catch (error) {
      $('#runProgress').hidden = true; $('#runAgainButton').disabled = false; setRunStatus('error', '执行失败'); renderRun(); showToast(error instanceof Error ? error.message : '自动化脚本执行失败');
    } finally { $('#startTestButton').disabled = false; }
  }
  function setRunStatus(type, text) { const status = $('#runStatus'); status.className = `result-status ${type === 'idle' ? '' : `is-${type}`}`; status.innerHTML = `<span class="status-dot"></span>${escapeHtml(text)}`; }
  function clearRun() { $('#resultsEmpty').hidden = false; $('#resultsContent').hidden = true; $('#runProgress').hidden = true; $('#step4').classList.add('is-locked'); setRunStatus('idle', '尚未执行'); }
  function statusText(status) { return ({ queued: '排队中', running: '执行中', success: '成功', failed: '失败' })[status] || '未知'; }
  function statusClass(status) { return status === 'success' ? 'success' : status === 'failed' ? 'failed' : 'pending'; }
  function renderRunActions(item, canDelete, runId) {
    const hasVideo = (item.status === 'success' || item.status === 'failed') && item.videoUrl;
    const videoTitle = `第 ${item.index} 次测试${item.status === 'failed' ? '失败' : ''}视频`;
    const viewAction = hasVideo ? `<button class="run-action run-video" type="button" data-video-url="${escapeHtml(item.videoUrl)}" data-video-title="${videoTitle}">查看视频</button>` : item.status === 'success' ? '<span class="run-action-empty">视频待生成</span>' : '';
    const downloadAction = hasVideo ? `<a class="run-action video-download" href="${escapeHtml(item.videoUrl)}" download="quick-test-${item.status}-${item.index}.mp4">下载视频</a>` : '';
    const deleteAction = canDelete ? `<button class="run-action record-delete" type="button" data-run-id="${escapeHtml(runId)}" data-result-index="${item.index}">删除记录</button>` : '';
    if (!viewAction && !downloadAction && !deleteAction) return '<span class="run-action-empty">—</span>';
    return `<span class="run-action-slot">${viewAction}</span><span class="run-action-slot">${downloadAction}</span><span class="run-action-slot">${deleteAction}</span>`;
  }
  function renderRun() {
    const run = state.run; if (!run) { clearRun(); return; } const visibleResults = run.results.filter((item) => !item.deleted); const successCount = visibleResults.filter((item) => item.status === 'success').length; const failedCount = visibleResults.filter((item) => item.status === 'failed').length; const completedCount = run.results.filter((item) => item.status === 'success' || item.status === 'failed').length; const durationEnd = run.completedAt || Date.now(); $('#metricTotal').textContent = visibleResults.length; $('#metricSuccess').textContent = successCount; $('#metricFailed').textContent = failedCount; $('#metricDuration').textContent = completedCount ? `${((durationEnd - run.startedAt) / 1000).toFixed(1)}s` : '—'; $('#runProgressText').textContent = `${completedCount} / ${run.total}`; $('#runProgressBar').style.width = `${(completedCount / run.total) * 100}%`;
    const historyRuns = state.runs.filter((historyRun) => historyRun.results.some((item) => !item.deleted));
    $('#runTable').innerHTML = historyRuns.map((historyRun, runIndex) => { const historyResults = historyRun.results.filter((item) => !item.deleted).slice().sort((a, b) => b.index - a.index); const canDelete = Boolean(historyRun.completedAt); const historyStatus = historyRun.status === 'running' ? '执行中' : historyRun.failed ? '部分失败' : '已完成'; const historyStatusClass = historyRun.status === 'running' ? 'pending' : historyRun.failed ? 'failed' : 'success'; const startedAt = historyRun.startedAt ? new Date(historyRun.startedAt).toLocaleString('zh-CN', { hour12: false }) : '时间未知'; const rows = historyResults.map((item) => `<div class="run-row"><span class="run-index">#${String(item.index).padStart(2, '0')}</span><span class="run-status ${statusClass(item.status)}"><i></i>${statusText(item.status)}</span><span class="run-duration">${escapeHtml(item.duration)}</span><span class="run-actions">${renderRunActions(item, canDelete, historyRun.runId)}</span></div>`).join(''); return `<section class="history-run"><div class="history-run-head"><div><strong>执行记录 ${String(runIndex + 1).padStart(2, '0')}</strong><span>${escapeHtml(startedAt)} · ${historyRun.total} 次测试</span></div><span class="history-run-status ${historyStatusClass}"><i></i>${historyStatus}</span></div><div class="run-table">${rows}</div></section>`; }).join('') || '<div class="run-table-empty">暂无测试记录。</div>';
    $$('.record-delete').forEach((button) => button.addEventListener('click', () => deleteRecord(button.dataset.runId, Number(button.dataset.resultIndex)))); $$('.run-video').forEach((button) => button.addEventListener('click', () => openVideo(button.dataset.videoUrl, button.dataset.videoTitle)));
  }
  async function deleteRecord(runId, index) { if (!runId || !window.confirm(`确定删除第 ${index} 条测试记录及其视频吗？`)) return; await deleteRunResource(`/api/quick-test/run/${encodeURIComponent(runId)}/results/${index}`, '测试记录已删除', runId); }
  async function deleteRunResource(url, successMessage, runId) { try { const response = await fetch(url, { method: 'DELETE' }); const payload = await response.json(); if (!response.ok) throw new Error(payload.error || '删除失败'); if (payload.results?.length) applyRunPayload(payload); else { state.runs = state.runs.filter((run) => run.runId !== runId); if (state.run?.runId === runId) { state.run = state.runs[0] || null; state.currentUrl = state.run?.targetUrl || ''; } } renderRun(); showToast(successMessage); } catch (error) { showToast(error instanceof Error ? error.message : '删除失败'); } }

  async function copyCurrentUrl() { if (!state.currentUrl) { showToast('请先准备并校验链接'); return; } try { await navigator.clipboard.writeText(state.currentUrl); showToast('链接已复制到剪贴板'); } catch { showToast('当前浏览器不允许复制，请手动选择链接'); } }
  function openVideo(url, title) { $('#videoTitle').textContent = title || '测试视频'; const player = $('#videoPlayer'); const fallback = $('#videoFallback'); if (url) { player.src = url; player.hidden = false; fallback.hidden = true; } else { player.removeAttribute('src'); player.hidden = true; fallback.hidden = false; fallback.querySelector('strong').textContent = '视频暂未生成'; fallback.querySelector('p').textContent = '自动化脚本完成后，成功视频会从本地 output/quick-test-videos/success 目录加载。'; } $('#videoModal').hidden = false; }
  function closeModal(id) { $(`#${id}`).hidden = true; if (id === 'advancedModal') { $('#advancedFields').hidden = true; $('#advancedToggle').setAttribute('aria-expanded', 'false'); } if (id === 'videoModal') { $('#videoPlayer').pause(); $('#videoPlayer').removeAttribute('src'); } }
  function openAdvancedModal() { ensureAdvancedModal(); $('#advancedFields').hidden = false; $('#advancedModal').hidden = false; $('#advancedToggle').setAttribute('aria-expanded', 'true'); $('#originalUrl').focus(); }
  function addEvent(selector, eventName, handler) { const element = $(selector); if (element) element.addEventListener(eventName, handler); }
  function setMode(mode) { state.mode = mode; $('#autoTab').classList.toggle('is-active', mode === 'auto'); $('#manualTab').classList.toggle('is-active', mode === 'manual'); $('#autoTab').setAttribute('aria-selected', mode === 'auto'); $('#manualTab').setAttribute('aria-selected', mode === 'manual'); $('#autoContent').hidden = mode !== 'auto'; $('#manualContent').hidden = mode !== 'manual'; }

  function bindEvents() {
    $('#autoTab').addEventListener('click', () => setMode('auto')); $('#manualTab').addEventListener('click', () => setMode('manual')); $('#advancedToggle').addEventListener('click', openAdvancedModal);
    $('#generateButton').addEventListener('click', () => { const valid = validateAndRender(buildUrl(buildParams()), '链接已准备就绪'); showToast(valid ? '链接生成并校验通过' : '链接已生成，请检查规范'); }); $('#validateButton').addEventListener('click', () => { const rawUrl = getInput('manualUrl'); if (!rawUrl) { showToast('请先粘贴一个测试链接'); return; } validateAndRender(rawUrl, '链接解析完成'); });
    $('#copyButton').addEventListener('click', copyCurrentUrl); $('#copyInlineButton').addEventListener('click', copyCurrentUrl); $('#openButton').addEventListener('click', () => { if (state.currentUrl) window.open(state.currentUrl, '_blank', 'noopener'); });
    $('#startTestButton').addEventListener('click', startTests); $('#runAgainButton').addEventListener('click', startTests); $('#testCount').addEventListener('input', () => normalizeNumberInput('testCount')); $('#concurrency').addEventListener('input', () => normalizeNumberInput('concurrency')); $$('[data-step-target]').forEach((button) => button.addEventListener('click', () => { const input = $(`#${button.dataset.stepTarget}`); input.value = Number(input.value) + Number(button.dataset.step); normalizeNumberInput(button.dataset.stepTarget); }));
    addEvent('#openParametersButton', 'click', () => { $('#parameterModal').hidden = false; }); addEvent('#closeParametersButton', 'click', () => closeModal('parameterModal')); addEvent('#modalDoneButton', 'click', () => closeModal('parameterModal')); addEvent('#closeAdvancedButton', 'click', () => closeModal('advancedModal')); addEvent('#advancedDoneButton', 'click', () => closeModal('advancedModal')); addEvent('#closeVideoButton', 'click', () => closeModal('videoModal')); $$('.modal-backdrop, .video-backdrop').forEach((backdrop) => backdrop.addEventListener('click', (event) => { if (event.target === backdrop) closeModal(backdrop.id); })); document.addEventListener('click', (event) => { const target = event.target?.closest?.('#closeAdvancedButton, #advancedDoneButton'); if (target) closeModal('advancedModal'); });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { closeModal('parameterModal'); closeModal('advancedModal'); closeModal('videoModal'); } if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); if (state.mode === 'auto') $('#generateButton').click(); else $('#validateButton').click(); } });
  }

  initialize();
})();
