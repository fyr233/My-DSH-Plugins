/* Self-contained Client half; persistence and prompt ownership remain on the Host. */
window.__ModuleLoader__.load({
  id: '@local/dsh-plugin-prompt-customizer',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'prompt-customizer-ui';
    const fields = ['identity', 'prefix', 'suffix'];
    const defaults = () => ({ identity: null, prefix: null, suffix: null });
    const dictionaries = {
      zh: {
        title: '提示词自定义', introduction: '仅覆盖身份开场白、前置角色与后置角色，保留其他提示词段。',
        scopeTitle: '生效范围', scope: '当前 profile 的顶层 Agent；不包含子 Agent；完整提示词（complete-prompt）预设不支持，单一提示词段的组装也会跳过。',
        persistence: '设置保存在 Host，刷新页面或重启后保留。保存后从下一次模型请求生效，不改变已经发出的请求。',
        semantics: '使用默认：交回 Harness／预设决定。自定义留空：隐藏该段。文本按原文使用。',
        identity: '身份开场白', prefix: '前置角色', suffix: '后置角色',
        identityHelp: '位于提示词开头，描述助手身份。', prefixHelp: '位于常规指导之前，定义任务定位与工作方式。', suffixHelp: '位于常规指导之后，补充语言、风格等要求。',
        inherit: '使用默认', custom: '自定义', placeholder: '输入自定义文本；留空将隐藏该段。', inherited: '沿用 Harness／当前预设的内容（不是固定默认文本）。',
        hidden: '该段将在保存后隐藏。', save: '保存并应用', reset: '全部恢复默认',
        saving: '正在保存…', loading: '正在读取设置…', retry: '重新读取',
        refreshHint: '重新读取会丢弃尚未保存的编辑。', readonly: '当前设置为只读，不能保存或恢复默认。',
        unsaved: '有未保存的修改', unchanged: '与已保存设置一致',
        saved: '已持久化保存并重新读取。适用的 Agent 将从下一次模型请求使用新设置；此提示不代表逐个 Agent 的应用验证。', resetDone: '已恢复默认并重新读取。将从下一次模型请求生效。',
        loadFailed: '读取失败', saveFailed: '保存失败；本地编辑已保留',
        refreshFailed: 'Host 已接受保存，但重新读取失败；请重新读取确认最终状态。',
        conflict: '设置已被其他操作修改。请先重新读取最新版本，再编辑并保存。',
        missing: '未找到 prompt-customizer 设置命名空间，请确认 Host 插件已启用。',
        ambiguous: '发现多个 prompt-customizer 设置命名空间，无法安全选择。',
        invalid: 'Host 返回的提示词设置格式无效。', unknown: '未知错误',
      },
      en: {
        title: 'Prompt customization', introduction: 'Override only the identity, persona prefix and persona suffix; keep other prompt sections intact.',
        scopeTitle: 'Scope', scope: 'Top-level Agents in the current profile only; child Agents are excluded; complete-prompt presets are unsupported and single-section assemblies are skipped.',
        persistence: 'Settings are stored on the Host and survive refreshes and restarts. Saved changes apply from the next model request, not requests already sent.',
        semantics: 'Inherit lets Harness / the preset decide. An empty custom value hides the section. Custom text is used literally.',
        identity: 'Identity opening', prefix: 'Persona prefix', suffix: 'Persona suffix',
        identityHelp: 'At the beginning of the prompt; describes the assistant’s identity.', prefixHelp: 'Before normal guidance; defines the task and working style.', suffixHelp: 'After normal guidance; adds language and style preferences.',
        inherit: 'Use default', custom: 'Custom', placeholder: 'Enter custom text; leave empty to hide this section.', inherited: 'Inherits Harness / the current preset (not a fixed default string).',
        hidden: 'This section will be hidden after saving.', save: 'Save and apply', reset: 'Restore all defaults',
        saving: 'Saving…', loading: 'Loading settings…', retry: 'Reload settings',
        refreshHint: 'Reloading discards unsaved edits.', readonly: 'Settings are read-only. Saving and restoring defaults are unavailable.',
        unsaved: 'Unsaved changes', unchanged: 'Matches saved settings',
        saved: 'Persisted and re-read. Eligible Agents use the settings from their next model request; this is not per-Agent application verification.', resetDone: 'Defaults restored and re-read. Changes apply from the next model request.',
        loadFailed: 'Could not load settings', saveFailed: 'Could not save; local edits are preserved',
        refreshFailed: 'The Host accepted the save, but re-reading failed. Reload to confirm the final state.',
        conflict: 'Another operation changed these settings. Reload the latest version before editing and saving again.',
        missing: 'The prompt-customizer settings namespace was not found. Check that the Host plugin is enabled.',
        ambiguous: 'Multiple prompt-customizer namespaces were found; a safe selection is not possible.',
        invalid: 'The Host returned an invalid prompt settings value.', unknown: 'Unknown error',
      },
    };
    const css = `
      .dsh-pc{color:var(--dsw-alias-label-primary);font:inherit;max-width:760px;min-width:0;padding:4px 0 24px;line-height:1.6}
      .dsh-pc *{box-sizing:border-box}
      .dsh-pc h2{font-size:20px;line-height:1.4;margin:0 0 8px;font-weight:600}
      .dsh-pc p{margin:0 0 10px}
      .dsh-pc .pc-muted{color:var(--dsw-alias-label-secondary);font-size:13px}
      .dsh-pc .pc-scope{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:12px;padding:14px 16px;margin:18px 0}
      .dsh-pc .pc-scope strong{display:block;margin-bottom:4px;font-size:13px}
      .dsh-pc .pc-scope p:last-child{margin-bottom:0}
      .dsh-pc .pc-field{border:0;border-bottom:1px solid var(--dsw-alias-border-l2);margin:0;padding:18px 0;min-width:0}
      .dsh-pc .pc-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:6px}
      .dsh-pc .pc-name{font-weight:600;font-size:14px}
      .dsh-pc .pc-key{display:block;font-size:11px;font-weight:400;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
      .dsh-pc .pc-inherit{display:flex;align-items:center;gap:7px;font-size:13px;cursor:pointer;white-space:nowrap}
      .dsh-pc input{accent-color:var(--dsw-alias-brand-primary);width:16px;height:16px;margin:0}
      .dsh-pc textarea{display:block;width:100%;min-height:106px;resize:vertical;padding:11px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.6}
      .dsh-pc textarea:disabled{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);opacity:.7;cursor:not-allowed}
      .dsh-pc textarea::placeholder{color:var(--dsw-alias-label-secondary)}
      .dsh-pc :is(textarea,button,input):focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}
      .dsh-pc .pc-footnote{font-size:12px;color:var(--dsw-alias-label-secondary);margin:7px 0 0}
      .dsh-pc .pc-actions{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin:20px 0 10px}
      .dsh-pc button{font:inherit;font-size:13px;line-height:20px;min-height:36px;padding:7px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer}
      .dsh-pc button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
      .dsh-pc button.pc-primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);font-weight:600}
      .dsh-pc button:disabled{opacity:.5;cursor:not-allowed}
      .dsh-pc .pc-status{font-size:13px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;margin-top:12px;overflow-wrap:anywhere;white-space:pre-wrap}
      .dsh-pc .pc-error{color:var(--dsw-alias-state-error-primary)}
      .dsh-pc .pc-success{color:var(--dsw-alias-state-success-primary)}
    `;
    function unwrap(result) {
      if (result?.ok === true) return result.value;
      const detail = result?.error;
      const error = new Error(typeof detail?.message === 'string' ? detail.message : typeof detail === 'string' ? detail : '');
      error.code = detail?.code;
      throw error;
    }
    function localError(key) { const error = new Error(); error.key = key; return error; }
    function parseDescription(description) {
      const namespaces = description?.namespaces;
      if (!Array.isArray(namespaces)) throw localError('invalid');
      const exact = namespaces.find(row => row.ns === 'prompt-customizer' || row.ns === 'include:prompt-customizer');
      const candidates = exact ? [exact] : namespaces.filter(row => typeof row.ns === 'string' && row.ns.endsWith(':prompt-customizer'));
      if (!candidates.length) throw localError('missing');
      if (candidates.length !== 1) throw localError('ambiguous');
      const row = candidates[0];
      const value = row.value?.overrides;
      if (!value || fields.some(key => value[key] !== null && typeof value[key] !== 'string') || !Number.isSafeInteger(row.revision)) throw localError('invalid');
      return { ns: row.ns, revision: row.revision, readOnly: description.writable !== true, overrides: Object.fromEntries(fields.map(key => [key, value[key]])) };
    }
    return {
      inject: ['slots', 'locale', 'remote', 'remote.settings'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, dictionaries), 'prompt-customizer: locale');
        const t = ctx.locale.bind(NS);
        const subscribeLocale = callback => ctx.locale.subscribe(callback);
        const getLocale = () => ctx.locale.getSnapshot();
        function Settings(props) {
          React.useSyncExternalStore(subscribeLocale, getLocale, getLocale);
          const id = React.useId();
          const [snapshot, setSnapshot] = React.useState(null);
          const [draft, setDraft] = React.useState(defaults);
          const [busy, setBusy] = React.useState('load');
          const [notice, setNotice] = React.useState(null);
          const [error, setError] = React.useState(null);
          const [needsReload, setNeedsReload] = React.useState(false);
          const alive = React.useRef(false);
          const locked = React.useRef(false);
          const readOnly = props.readOnly === true || snapshot?.readOnly === true;
          const disabled = !!busy || !snapshot || readOnly || needsReload;
          const dirty = !!snapshot && fields.some(key => snapshot.overrides[key] !== draft[key]);
          const read = async () => parseDescription(unwrap(await ctx.remote.settings.describe()));
          const accept = next => { setSnapshot(next); setDraft({ ...next.overrides }); setNeedsReload(false); };
          async function reload() {
            if (locked.current) return;
            locked.current = true;
            setBusy('load'); setError(null); setNotice(null);
            try { const next = await read(); if (alive.current) accept(next); }
            catch (cause) { if (alive.current) { setError({ key: 'loadFailed', cause }); setNeedsReload(true); } }
            finally { locked.current = false; if (alive.current) setBusy(null); }
          }
          React.useEffect(() => { alive.current = true; void reload(); return () => { alive.current = false; }; }, []);
          async function save(reset) {
            if (locked.current || disabled) return;
            locked.current = true;
            setBusy('save'); setError(null); setNotice(null);
            let accepted = false;
            try {
              const overrides = reset ? defaults() : { ...draft };
              unwrap(await ctx.remote.settings.update(snapshot.ns, { overrides }, snapshot.revision));
              accepted = true;
              const next = await read();
              if (alive.current) { accept(next); setNotice(reset ? 'resetDone' : 'saved'); }
            } catch (cause) {
              if (alive.current) {
                setError({ key: accepted ? 'refreshFailed' : 'saveFailed', cause });
                if (accepted || cause?.code === 'settings/conflict') setNeedsReload(true);
              }
            } finally { locked.current = false; if (alive.current) setBusy(null); }
          }
          function change(key, value) {
            setDraft(previous => ({ ...previous, [key]: value }));
            setNotice(null); setError(null);
          }
          function errorText(cause) {
            if (cause?.key) return t(cause.key);
            const detail = cause?.message || t('unknown');
            return cause?.code ? `${cause.code}: ${detail}` : detail;
          }
          const sectionKeys = { identity: 'harness:identity', prefix: 'deployment:persona-prefix', suffix: 'deployment:persona-suffix' };
          return h('section', { className: 'dsh-pc', 'aria-labelledby': `${id}-title`, 'aria-busy': !!busy },
            h('style', null, css),
            h('h2', { id: `${id}-title` }, t('title')),
            h('p', { className: 'pc-muted' }, t('introduction')),
            h('div', { className: 'pc-scope' }, h('strong', null, t('scopeTitle')), h('p', { className: 'pc-muted' }, t('scope')), h('p', { className: 'pc-muted' }, t('persistence'))),
            h('p', { className: 'pc-muted' }, t('semantics')),
            readOnly && h('p', { role: 'note', className: 'pc-status' }, t('readonly')),
            busy === 'load' && h('p', { role: 'status', className: 'pc-muted' }, t('loading')),
            snapshot && fields.map(key => {
              const inherited = draft[key] === null;
              const inputId = `${id}-${key}`;
              return h('div', { className: 'pc-field', key },
                h('div', { className: 'pc-heading' },
                  h('label', { className: 'pc-name', htmlFor: inputId }, t(key), h('span', { className: 'pc-key' }, sectionKeys[key])),
                  h('label', { className: 'pc-inherit' }, h('input', { type: 'checkbox', checked: inherited, disabled, onChange: event => change(key, event.target.checked ? null : '') }), t('inherit'))),
                h('p', { id: `${inputId}-help`, className: 'pc-muted' }, t(`${key}Help`)),
                h('textarea', { id: inputId, rows: 4, maxLength: 32000, value: draft[key] ?? '', disabled: disabled || inherited, 'aria-describedby': `${inputId}-help ${inputId}-note`, placeholder: t(inherited ? 'inherited' : 'placeholder'), spellCheck: false, onChange: event => change(key, event.target.value) }),
                h('p', { id: `${inputId}-note`, className: 'pc-footnote' }, t(inherited ? 'inherited' : draft[key] === '' ? 'hidden' : 'custom')));
            }),
            h('div', { className: 'pc-actions' },
              h('button', { type: 'button', className: 'pc-primary', disabled: disabled || !dirty, onClick: () => void save(false) }, t(busy === 'save' ? 'saving' : 'save')),
              h('button', { type: 'button', disabled, onClick: () => void save(true) }, t('reset')),
              h('button', { type: 'button', disabled: !!busy, onClick: () => void reload(), title: t('refreshHint') }, t('retry'))),
            snapshot && h('p', { className: 'pc-footnote' }, t(dirty ? 'unsaved' : 'unchanged')),
            h('p', { className: 'pc-footnote' }, t('refreshHint')),
            notice && h('div', { role: 'status', className: 'pc-status pc-success' }, t(notice)),
            error && h('div', { role: 'alert', className: 'pc-status pc-error' }, t(error.key), '\n', errorText(error.cause), error.cause?.code === 'settings/conflict' ? `\n${t('conflict')}` : null));
        }
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'prompt-customizer', order: 25, label: () => t('title'),
        }, Settings));
      },
    };
  },
});
