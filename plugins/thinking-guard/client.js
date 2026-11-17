/* Self-contained Client half; persistence and stream ownership remain on the Host. */
window.__ModuleLoader__.load({
  id: '@local/dsh-plugin-thinking-guard',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'thinking-guard-ui';
    /** Host route owned by this plugin (see index.js ROUTE_PREFIX). */
    const API_BASE = '/thinking-guard/api/settings';
    const DEFAULTS = ['<thinking>', '<thought>'];
    const dictionaries = {
      zh: {
        title: '思维链标识',
        intro: '模型有时把思考内容写进正文，并包在这些标签里。列出标签名，插件会在消息落盘前把这类内容改写成折叠的推理块。',
        scopeTitle: '生效范围',
        scope: '当前 profile 的全部模型调用；子 Agent 同样适用。保存后从下一次模型调用生效，不需要重载。',
        semantics: '每行一个标识，按原样匹配：写 <thinking> 就找 <thinking>，写 【思考】 就找 【思考】，不要求是尖括号标签。仅当正文以该标识开头时才改写，正文中间引用的不受影响。',
        markers: '标签列表',
        columnOpen: '起始标记', columnClose: '结束标记',
        openPlaceholder: '如 <thinking> 或 【思考】', closePlaceholder: '必填：结束标记',
        derivedHint: '由起始标记自动推导，无需填写',
        addRow: '添加一行', removeRow: '删除这一行',
        markersHelp: '起始标记是正文开头要匹配的文本，最长 64 字符。形如 <xxx> 的标签会自动推导出结束标记；其它写法（如 【思考】）必须自己填写结束标记，否则无法保存。',
        closingRequired: '有起始标记推导不出结束标记，请补全结束标记后再保存。',
        placeholder: '<thinking>\n<thought>',
        enabled: '启用拦截', enabledHelp: '关闭后插件完全不介入，思考内容会按原样出现在正文。',
        keepMarkers: '在折叠块内保留标识文本',
        keepMarkersHelp: '默认关闭：折叠块只保留块内文字。开启后会原样保留 <thinking> 这类标识便于排查，但下次请求会把标识一并回传给模型，可能强化这种格式。',
        save: '保存并应用', reset: '恢复默认', reload: '重新读取',
        saving: '正在保存…', loading: '正在读取设置…',
        saved: '已保存。下一次模型调用即生效。', resetDone: '已恢复默认并保存。',
        unsaved: '有未保存的修改', unchanged: '与已保存设置一致',
        readonly: '当前设置为只读。',
        loadFailed: '读取失败', saveFailed: '保存失败，本地编辑已保留',
        invalid: '标识不能为空，且要写开标记而不是闭标记', tooLong: '单个标识最长 64 字符', missing: '未找到 thinking-guard 设置命名空间，请确认 Host 插件已启用。',
        conflict: '设置已被其他操作修改，请重新读取后再保存。',
        refreshHint: '重新读取会丢弃未保存的编辑。',
      },
      en: {
        title: 'Thinking markers',
        intro: 'Models sometimes write their reasoning into the reply body wrapped in tags. List those tag names; the plugin reclassifies such content into a collapsed reasoning block before the message is stored.',
        scopeTitle: 'Scope',
        scope: 'Every model call in this profile, child Agents included. A saved list applies from the next model call; no reload needed.',
        semantics: 'One marker per line, matched literally: <thinking> looks for <thinking>, 【思考】 looks for 【思考】. It does not have to be an angle-bracket tag. Only a body that OPENS with the marker is rewritten, so one quoted mid-reply is untouched.',
        markers: 'Marker list', markersHelp: 'Keep at least one. When a new leak shape appears, add it here.',
        placeholder: '<thinking>\n<thought>',
        enabled: 'Enable the guard', enabledHelp: 'When off, the plugin does nothing and leaked reasoning appears in the body as-is.',
        keepMarkers: 'Keep the marker text inside the folded block',
        keepMarkersHelp: 'Off by default: the folded block keeps only its inner text. Turning it on keeps the marker (e.g. <thinking>) for debugging, but that marker is then sent back to the model, which can reinforce the format.',
        save: 'Save and apply', reset: 'Restore defaults', reload: 'Reload',
        saving: 'Saving…', loading: 'Loading settings…',
        saved: 'Saved. Applies from the next model call.', resetDone: 'Defaults restored and saved.',
        unsaved: 'Unsaved changes', unchanged: 'Matches saved settings',
        readonly: 'Settings are read-only.',
        loadFailed: 'Could not load settings', saveFailed: 'Could not save; local edits are preserved',
        invalid: 'A marker cannot be empty, and must be an opening marker', tooLong: 'A marker is at most 64 characters', missing: 'The thinking-guard settings namespace was not found. Check that the Host plugin is enabled.',
        conflict: 'Another operation changed these settings. Reload before saving again.',
        refreshHint: 'Reloading discards unsaved edits.',
      },
    };
    const css = `
      .dsh-tg{color:var(--dsw-alias-label-primary);font:inherit;max-width:760px;min-width:0;padding:4px 0 24px;line-height:1.6}
      .dsh-tg *{box-sizing:border-box}
      .dsh-tg h2{font-size:20px;line-height:1.4;margin:0 0 8px;font-weight:600}
      .dsh-tg p{margin:0 0 10px}
      .dsh-tg .tg-muted{color:var(--dsw-alias-label-secondary);font-size:13px}
      .dsh-tg .tg-scope{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:12px;padding:14px 16px;margin:18px 0}
      .dsh-tg .tg-scope strong{display:block;margin-bottom:4px;font-size:13px}
      .dsh-tg .tg-scope p:last-child{margin-bottom:0}
      .dsh-tg .tg-field{border:0;border-bottom:1px solid var(--dsw-alias-border-l2);margin:0;padding:18px 0}
      .dsh-tg .tg-name{font-weight:600;font-size:14px;display:block;margin-bottom:6px}
      .dsh-tg textarea{display:block;width:100%;min-height:132px;resize:vertical;padding:11px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.6;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
      .dsh-tg textarea:disabled{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);opacity:.7}
      .dsh-tg :is(textarea,button,input):focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}
      .dsh-tg .tg-check{display:flex;align-items:center;gap:8px;font-size:13px;margin:0 0 6px}
      .dsh-tg input{accent-color:var(--dsw-alias-brand-primary);width:16px;height:16px;margin:0}
      .dsh-tg .tg-grid{display:grid;grid-template-columns:1fr 1fr 32px;gap:8px;align-items:center;margin:6px 0}
      .dsh-tg .tg-grid-head{font-size:12px;color:var(--dsw-alias-label-secondary);font-weight:600;margin:10px 0 2px}
      .dsh-tg .tg-grid input{width:100%;min-height:34px;padding:6px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
      .dsh-tg .tg-grid input:disabled{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);opacity:.7}
      .dsh-tg .tg-grid input.tg-auto{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);cursor:default}
      .dsh-tg .tg-grid input.tg-missing{border-color:var(--dsw-alias-state-error-primary)}
      .dsh-tg .tg-row-remove{width:32px;height:32px;min-height:32px;padding:0;font-size:16px;line-height:1;border-radius:8px}
      .dsh-tg .tg-add{align-self:flex-start;margin-top:4px}
      .dsh-tg .tg-foot{font-size:12px;color:var(--dsw-alias-label-secondary);margin:7px 0 0}
      .dsh-tg .tg-actions{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin:20px 0 10px}
      .dsh-tg button{font:inherit;font-size:13px;line-height:20px;min-height:36px;padding:7px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer}
      .dsh-tg button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
      .dsh-tg button.tg-primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);font-weight:600}
      .dsh-tg button:disabled{opacity:.5;cursor:not-allowed}
      .dsh-tg .tg-status{font-size:13px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;margin-top:12px;overflow-wrap:anywhere;white-space:pre-wrap}
      .dsh-tg .tg-error{color:var(--dsw-alias-state-error-primary)}
      .dsh-tg .tg-success{color:var(--dsw-alias-state-success-primary)}
    `;

    function localError(key) { const error = new Error(); error.key = key; return error; }

    /** Validate one line exactly as the Host will store it. */
    function toMarker(entry) {
      const text = String(entry ?? '').trim();
      if (text === '' || text.startsWith('</')) throw localError('invalid');
      if (text.length > 64) throw localError('tooLong');
      return text;
    }
    /**
     * The same closing-tag rule the Host uses: an angle-bracket tag closes with
     * its bare name, attributes notwithstanding. Anything else has no inferable
     * close and the user must type one.
     */
    function deriveClosing(open) {
      const text = String(open ?? '').trim();
      if (text.length < 3 || !text.startsWith('<') || !text.endsWith('>')) return null;
      const match = /^([A-Za-z][A-Za-z0-9._:-]*)(?:\s[^>]*)?$/.exec(text.slice(1, -1));
      return match === null ? null : '</' + match[1] + '>';
    }

    /** A stored entry (`open` or `open => close`) as one editable row. */
    function rowOf(entry) {
      const text = String(entry ?? '').trim();
      const sep = text.indexOf('=>');
      if (sep !== -1) {
        return { open: text.slice(0, sep).trim(), close: text.slice(sep + 2).trim(), auto: false };
      }
      const auto = deriveClosing(text);
      return { open: text, close: auto ?? '', auto: auto !== null };
    }

    /** One row in its stored form, for the dirty comparison only. */
    function serializeRow(row) {
      const open = String(row.open ?? '').trim();
      const auto = deriveClosing(open);
      if (auto !== null) return open;
      return open + ' => ' + String(row.close ?? '').trim();
    }
    /** A whole list in canonical stored form. */
    function rowsToForm(rows) {
      return rows.map(row => (typeof row === 'string' ? row : serializeRow(row))).join('\n');
    }

    /** Rows back into the stored form: derived closes are not written. */
    function rowsToMarkers(rows) {
      const markers = [];
      const seen = new Set();
      for (const row of rows) {
        const open = toMarker(row.open);
        if (seen.has(open)) continue;
        seen.add(open);
        const auto = deriveClosing(open);
        if (auto !== null) { markers.push(open); continue; }
        const close = String(row.close ?? '').trim();
        if (close === '') throw localError('closingRequired');
        if (close.length > 64) throw localError('tooLong');
        markers.push(open + ' => ' + close);
      }
      if (markers.length === 0) throw localError('invalid');
      return markers;
    }

    /** Validate the Host's preferences payload. */
    function parsePreferences(body) {
      const value = body?.value;
      if (body?.ok !== true || value === null || typeof value !== 'object') throw localError('invalid');
      const markers = value.markers;
      if (!Array.isArray(markers) || markers.length === 0 || markers.some(m => typeof m !== 'string')) throw localError('invalid');
      return {
        markers,
        enabled: value.enabled !== false,
        keepMarkers: value.keepMarkers === true,
        note: typeof value.note === 'string' ? value.note : '',
      };
    }

    /** Read the Host's saved preferences. */
    async function readRemote() {
      const response = await fetch(API_BASE, { cache: 'no-store', headers: { accept: 'application/json' } });
      if (!response.ok) throw localError('missing');
      return parsePreferences(await response.json());
    }

    /** Merge and persist; resolves to the Host's authoritative value. */
    async function writeRemote(patch) {
      const response = await fetch(API_BASE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const body = await response.json().catch(() => undefined);
      if (!response.ok || body?.ok !== true) {
        const error = new Error(body?.error?.message ?? 'save failed');
        error.key = 'saveFailed';
        throw error;
      }
      return parsePreferences(body);
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, dictionaries), 'thinking-guard: locale');
        const t = ctx.locale.bind(NS);
        const subscribeLocale = callback => ctx.locale.subscribe(callback);
        const getLocale = () => ctx.locale.getSnapshot();

        function Settings(props) {
          React.useSyncExternalStore(subscribeLocale, getLocale, getLocale);
          const id = React.useId();
          const [snapshot, setSnapshot] = React.useState(null);
          const [rows, setRows] = React.useState(() => DEFAULTS.map(rowOf));
          const [enabled, setEnabled] = React.useState(true);
          const [keepMarkers, setKeepMarkers] = React.useState(false);
          const [busy, setBusy] = React.useState('load');
          const [notice, setNotice] = React.useState(null);
          const [error, setError] = React.useState(null);
          const [needsReload, setNeedsReload] = React.useState(false);
          const alive = React.useRef(false);
          const locked = React.useRef(false);
          const readOnly = props.readOnly === true || snapshot?.readOnly === true;
          const disabled = !!busy || !snapshot || readOnly || needsReload;

          const savedForm = snapshot ? rowsToForm(snapshot.markers) : '';
          const dirty = !!snapshot && (savedForm !== rowsToForm(rows.map(serializeRow)) || snapshot.enabled !== enabled || snapshot.keepMarkers !== keepMarkers);
          /** Whether every row can be saved (each needs a closing marker). */
          const missingClose = rows.some(row => deriveClosing(row.open) === null && String(row.close ?? '').trim() === '');

          const read = readRemote;
          const accept = next => {
            setSnapshot(next);
            setRows(next.markers.map(rowOf));
            setEnabled(next.enabled);
            setKeepMarkers(next.keepMarkers);
            setNeedsReload(false);
          };

          async function reload() {
            if (locked.current) return;
            locked.current = true;
            setBusy('load'); setError(null); setNotice(null);
            try { const next = await read(); if (alive.current) accept(next); }
            catch (cause) { if (alive.current) { setError({ key: cause.key ?? 'loadFailed', cause }); setNeedsReload(true); } }
            finally { locked.current = false; if (alive.current) setBusy(null); }
          }
          React.useEffect(() => { alive.current = true; void reload(); return () => { alive.current = false; }; }, []);

          async function save(reset) {
            if (locked.current || disabled) return;
            locked.current = true;
            setBusy('save'); setError(null); setNotice(null);
            try {
              const markers = reset ? [...DEFAULTS] : rowsToMarkers(rows);
              const next = await writeRemote({
                markers,
                enabled: reset ? true : enabled,
                keepMarkers: reset ? false : keepMarkers,
              });
              if (alive.current) { accept(next); setNotice(reset ? 'resetDone' : 'saved'); }
            } catch (cause) {
              if (alive.current) setError({ key: cause.key ?? 'saveFailed', cause });
            } finally { locked.current = false; if (alive.current) setBusy(null); }
          }

          function updateRow(index, patch) {
            setRows(previous => previous.map((row, at) => (at === index ? { ...row, ...patch } : row)));
            setNotice(null); setError(null);
          }
          function removeRow(index) {
            setRows(previous => (previous.length === 1 ? previous : previous.filter((_, at) => at !== index)));
            setNotice(null); setError(null);
          }
          function addRow() {
            setRows(previous => [...previous, { open: '', close: '', auto: false }]);
            setNotice(null); setError(null);
          }

          function errorText(cause) {
            if (cause?.key) return t(cause.key);
            const detail = cause?.message || t('loadFailed');
            return cause?.code ? `${cause.code}: ${detail}` : detail;
          }

          return h('section', { className: 'dsh-tg', 'aria-labelledby': `${id}-title`, 'aria-busy': !!busy },
            h('style', null, css),
            h('h2', { id: `${id}-title` }, t('title')),
            h('p', { className: 'tg-muted' }, t('intro')),
            h('div', { className: 'tg-scope' },
              h('strong', null, t('scopeTitle')),
              h('p', { className: 'tg-muted' }, t('scope'))),
            h('p', { className: 'tg-muted' }, t('semantics')),
            readOnly && h('p', { role: 'note', className: 'tg-status' }, t('readonly')),
            busy === 'load' && h('p', { role: 'status', className: 'tg-muted' }, t('loading')),
            snapshot && h('div', { className: 'tg-field' },
              h('label', { className: 'tg-check' },
                h('input', {
                  type: 'checkbox', checked: enabled, disabled,
                  onChange: event => { setEnabled(event.target.checked); setNotice(null); setError(null); },
                }),
                t('enabled')),
              h('p', { className: 'tg-foot' }, t('enabledHelp')),
              h('label', { className: 'tg-check' },
                h('input', {
                  type: 'checkbox', checked: keepMarkers, disabled,
                  onChange: event => { setKeepMarkers(event.target.checked); setNotice(null); setError(null); },
                }),
                t('keepMarkers')),
              h('p', { className: 'tg-foot' }, t('keepMarkersHelp')),
              h('span', { className: 'tg-name' }, t('markers')),
              h('div', { className: 'tg-grid tg-grid-head', 'aria-hidden': 'true' },
                h('span', null, t('columnOpen')),
                h('span', null, t('columnClose')),
                h('span', null)),
              rows.map((row, index) => {
                const auto = deriveClosing(row.open);
                const rowId = `${id}-m${index}`;
                return h('div', { className: 'tg-grid', key: `${index}` },
                  h('input', {
                    id: rowId, type: 'text', value: row.open, disabled, spellCheck: false,
                    placeholder: t('openPlaceholder'),
                    'aria-label': t('columnOpen'),
                    onChange: event => updateRow(index, { open: event.target.value }),
                  }),
                  auto !== null
                    ? h('input', {
                      type: 'text', value: auto, readOnly: true, tabIndex: -1,
                      className: 'tg-auto', 'aria-label': t('columnClose'), title: t('derivedHint'),
                    })
                    : h('input', {
                      type: 'text', value: row.close, disabled, spellCheck: false,
                      placeholder: t('closePlaceholder'), 'aria-label': t('columnClose'),
                      className: row.close.trim() === '' ? 'tg-missing' : '',
                      onChange: event => updateRow(index, { close: event.target.value }),
                    }),
                  h('button', {
                    type: 'button', className: 'tg-row-remove', disabled,
                    title: t('removeRow'), 'aria-label': t('removeRow'),
                    onClick: () => removeRow(index),
                  }, '×'),
                );
              }),
              h('button', { type: 'button', className: 'tg-add', disabled, onClick: addRow }, t('addRow')),
              h('p', { className: 'tg-foot' }, t('markersHelp')),
              missingClose && h('p', { className: 'tg-foot tg-error', role: 'alert' }, t('closingRequired'))),
            h('div', { className: 'tg-actions' },
              h('button', { type: 'button', className: 'tg-primary', disabled: disabled || !dirty || missingClose, onClick: () => void save(false) }, t(busy === 'save' ? 'saving' : 'save')),
              h('button', { type: 'button', disabled, onClick: () => void save(true) }, t('reset')),
              h('button', { type: 'button', disabled: !!busy, onClick: () => void reload(), title: t('refreshHint') }, t('reload'))),
            snapshot && h('p', { className: 'tg-foot' }, t(dirty ? 'unsaved' : 'unchanged')),
            notice && h('div', { role: 'status', className: 'tg-status tg-success' }, t(notice)),
            error && h('div', { role: 'alert', className: 'tg-status tg-error' },
              t(error.key), '\n', errorText(error.cause)));
        }

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'thinking-guard', order: 26, label: () => t('title'),
        }, Settings));
      },
    };
  },
});
