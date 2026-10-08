window.__ModuleLoader__.load({ id: 'dsh-memory-dreaming', factory: require => {
const React = require('react');
// BEGIN GENERATED PLUGIN SETTINGS
// Embedded by build.mjs. React and the official Connection are provided by DSH.
const { Switch: DshSwitch, Button: DshButton } = require('@deepseek-ai/dsh-client-ui-primitives');
function createConfigScope(connection, endpoint) {
  let state = { status: 'loading', writable: connection.isLoopback !== false }, closed = false, serial = 0, saving = false;
  const listeners = new Set(), requests = new Set();
  const publish = next => { if (!closed) { state = next; for (const fn of listeners) fn(); } };
  const call = async (method, args) => {
    if (closed) throw new Error('插件已停用');
    const abort = new AbortController(); requests.add(abort);
    const timeout = setTimeout(() => abort.abort(), 15000);
    try {
      const result = await connection.rpc.call('/api', endpoint + '/' + method, { args }, abort.signal);
      if (!result.ok) throw Object.assign(new Error(result.error?.message || result.error?.code || '请求失败'), { code: result.error?.code });
      return result.value;
    } finally { clearTimeout(timeout); requests.delete(abort); }
  };
  const accept = value => publish({ ...value, status: 'ready', writable: connection.isLoopback !== false, requestError: '' });
  const scope = {
    getSnapshot: () => state,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async reload() {
      const sequence = ++serial;
      try { const value = await call('getConfig', {}); if (sequence === serial) accept(value); return value; }
      catch (error) { if (sequence === serial) publish({ ...state, requestError: error.message }); throw error; }
    },
    async update(value, revision = state.revision) {
      if (saving) throw new Error('正在保存，请稍候');
      saving = true; ++serial;
      try { const result = await call('setConfig', { value, revision }); accept(result); return result; }
      finally { saving = false; }
    },
    set(key, value) { return scope.update({ ...state.value, [key]: value }); },
    call,
    async runAction() { const result = await call('runAction', {}); accept(result); return result; },
    close() { closed = true; ++serial; for (const abort of requests) abort.abort(); listeners.clear(); },
  };
  return scope;
}
function useFileConfig(scope) {
  return React.useSyncExternalStore(scope.subscribe, scope.getSnapshot, scope.getSnapshot);
}
const configValue=(value,key)=>key.split('.').reduce((current,part)=>current?.[part],value);
const configChange=(value,key,next)=>{
  const [head,...tail]=key.split('.');
  return {...value,[head]:tail.length?configChange(value[head],tail.join('.'),next):next};
};
function ModelPicker({ scope, kind='chat', provider, model, disabled, label, onChange }) {
  const e=React.createElement, [catalog,setCatalog]=React.useState({groups:[]}), [error,setError]=React.useState('');
  React.useEffect(()=>{
    let active=true,sequence=0;
    const load=()=>{const current=++sequence;scope.call('modelCatalog',{kind}).then(value=>{if(active&&current===sequence){setCatalog(value);setError('');}}).catch(failure=>{if(active&&current===sequence)setError(failure.message);});};
    load();window.addEventListener('focus',load);return()=>{active=false;window.removeEventListener('focus',load);};
  },[scope,kind]);
  const encode=(provider,model)=>JSON.stringify([provider,model]),value=encode(provider||'',model||'');
  const known=catalog.groups.some(group=>group.models.some(entry=>group.id===provider&&entry.id===model));
  return e('div',null,e('select',{'aria-label':label,value,disabled,onChange:event=>{const [provider,model]=JSON.parse(event.target.value);onChange({provider,model});}},
    e('option',{value:encode('','')},kind==='embedding'?'词语检索（不使用向量模型）':'继承 DSH 默认模型'),
    provider&&model&&!known?e('option',{value},`${provider} / ${model}（当前配置）`):null,
    catalog.groups.map(group=>e('optgroup',{key:group.id,label:group.name||group.id},group.models.map(entry=>e('option',{key:entry.id,value:encode(group.id,entry.id)},entry.name||entry.id))))),
    error?e('small',{role:'status'},'模型目录暂不可用：'+error):kind==='embedding'&&!catalog.groups.length?e('small',null,'尚未注册向量模型。'):null);
}
function FileConfigPage({ scope, title, description, fields, actionLabel, credentialApi, credentials, credentialTitle='凭证', credentialsFirst=false }) {
  const e = React.createElement, snapshot = useFileConfig(scope);
  const [editor, setEditor] = React.useState({ base: null, draft: null, error: '', saved: false });
  const [busy, setBusy] = React.useState(false);
  const busyRef = React.useRef(false), alive = React.useRef(false);
  const dirty = !!editor.base && JSON.stringify(editor.draft) !== JSON.stringify(editor.base.value);
  const external = !!editor.base && snapshot.revision !== editor.base.revision;
  React.useEffect(() => {
    if (snapshot.status !== 'ready') return;
    setEditor(previous => !previous.base || (!busyRef.current && JSON.stringify(previous.draft) === JSON.stringify(previous.base.value))
      ? { base: snapshot, draft: structuredClone(snapshot.value), error: '', saved: previous.saved } : previous);
  }, [snapshot]);
  React.useEffect(() => {
    alive.current = true;
    let reloading = false;
    const reload = () => {
      if (busyRef.current || reloading) return;
      reloading = true;
      void scope.reload().catch(() => {}).finally(() => { reloading = false; });
    };
    reload(); window.addEventListener('focus', reload);
    const interval = actionLabel ? setInterval(() => { if (document.visibilityState !== 'hidden') reload(); }, 2000) : null;
    return () => { alive.current = false; window.removeEventListener('focus', reload); if (interval) clearInterval(interval); };
  }, [scope, actionLabel]);
  const work = async operation => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true);
    try { await operation(); }
    catch (error) { if (alive.current) setEditor(previous => ({ ...previous, error: error.message, errorCode: error.code, saved: false })); }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  };
  const replace = result => { if (alive.current) setEditor({ base: result, draft: structuredClone(result.value), error: '', saved: false }); };
  const change = (key, value) => setEditor(previous => ({ ...previous, draft: configChange(previous.draft,key,value), error: '', errorCode: '', saved: false }));
  const disabled = busy || !snapshot.writable || !editor.draft;
  const field = spec => {
    const value = configValue(editor.draft,spec.key), id = 'dsh-config-' + spec.key;
    const common = { id, disabled: disabled || spec.disabled, 'aria-label': spec.label };
    let input;
    if (spec.type === 'readonly') input = e('input', { ...common, type: 'text', readOnly: true, value: snapshot.details?.[spec.detail] ?? '', placeholder: spec.placeholder });
    else if (spec.type === 'boolean') input = e(DshSwitch, { label: spec.label, disabled: common.disabled, checked: value, onChange: next => change(spec.key, next) });
    else if (spec.type === 'multiline') input = e('textarea', {...common,rows:5,value,onChange:event=>change(spec.key,event.target.value)});
    else if (spec.type === 'list') input = e('textarea', {...common, rows: Math.max(3,Math.min(8,value.length+1)), value:editor.listText?.[spec.key]??value.join('\n'),
      onChange:event=>{const text=event.target.value;setEditor(previous=>({...previous,draft:configChange(previous.draft,spec.key,text.split(/[\n,]/).map(item=>item.trim()).filter(Boolean)),listText:{...previous.listText,[spec.key]:text},error:'',errorCode:'',saved:false}));} });
    else if (spec.type === 'model') input = e(ModelPicker,{scope,kind:spec.kind,provider:configValue(editor.draft,spec.providerKey),model:value,disabled:common.disabled,label:spec.label,onChange:selection=>setEditor(previous=>({...previous,draft:configChange(configChange(previous.draft,spec.providerKey,selection.provider),spec.key,selection.model),error:'',errorCode:'',saved:false}))});
    else if (spec.type === 'select') input = e('select', { ...common, value, onChange: event => change(spec.key, spec.numeric ? Number(event.target.value) : event.target.value) }, spec.options.map(([key, label]) => e('option', { key, value: key }, label)));
    else if (spec.type === 'order' || spec.type === 'providers') input = e('ol', { className: 'dpc-order' }, value.map((key, index) => e('li', { key },
      e('span', { className: 'dpc-rank', 'aria-hidden': true }, index + 1), e('span', { className: 'dpc-provider-name' }, spec.labels[key] || key),
      spec.type === 'providers' ? e(DshSwitch, { label: '启用 ' + (spec.labels[key] || key), checked: editor.draft.enabledProviders.includes(key), disabled,
        onChange: next => change('enabledProviders', next ? [...editor.draft.enabledProviders, key] : editor.draft.enabledProviders.filter(item => item !== key)) }) : null,
      e('div', { className: 'dpc-order-actions' }, ...[-1, 1].map(delta => e(DshButton, {
        key: delta, type: 'button', disabled: disabled || index + delta < 0 || index + delta >= value.length,
        variant: 'ghost', size: 'sm', className: 'dpc-arrow', title: delta < 0 ? '上移' : '下移',
        'aria-label': (delta < 0 ? '上移 ' : '下移 ') + (spec.labels[key] || key),
        onClick: () => { const next = [...value]; [next[index], next[index + delta]] = [next[index + delta], next[index]]; change(spec.key, next); },
      }, e('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, 'aria-hidden': true },
        e('path', { d: delta < 0 ? 'm6 15 6-6 6 6' : 'm6 9 6 6 6-6' }))))))));
    else if (spec.type === 'choices') input = e('div', null, Object.entries(spec.labels).map(([key, label]) => e('label', { className: 'dpc-choice', key }, e('input', {
      type: 'checkbox', checked: value.includes(key), disabled, onChange: event => change(spec.key, event.target.checked ? [...value, key] : value.filter(x => x !== key)),
    }), ' ', label)));
    else input = e('input', { ...common, type: spec.type === 'number' ? 'number' : 'text', value,
      min: spec.min, max: spec.max, step: spec.step ?? 1,
      onChange: event => change(spec.key, spec.type === 'number' ? Number(event.target.value) : event.target.value),
    });
    return e('div', { className: 'dpc-field dpc-' + spec.type, key: spec.key },
      e('div', { className: 'dpc-label' }, e('label', { htmlFor: spec.type === 'boolean' ? undefined : id }, spec.label), spec.help ? e('small', null, spec.help) : null, spec.emptyHelp&&Array.isArray(value)&&!value.length?e('small',null,spec.emptyHelp):null),
      e('div', { className: 'dpc-control' }, input));
  };
  const visible=spec=>!spec.when||(Array.isArray(spec.when)?spec.when:[spec.when]).some(condition=>Object.entries(condition).every(([key,value])=>configValue(editor.draft,key)===value));
  const grouped=advanced=>{
    const groups=[];
    for(const spec of fields.filter(spec=>!!spec.advanced===advanced&&visible(spec))){
      if(!groups.length||groups.at(-1).title!==(spec.group||''))groups.push({title:spec.group||'',fields:[]});
      groups.at(-1).fields.push(spec);
    }
    return groups.map((group,index)=>e('section',{className:'dpc-group',key:index},group.title?e('h4',null,group.title):null,group.fields.map(field)));
  };
  const credentialView=credentialApi&&credentials&&snapshot.value?e(CredentialsPage,{api:credentialApi,refs:credentials(snapshot.value),writable:snapshot.writable,title:credentialTitle,expanded:credentialsFirst}):null;
  const reloadNeeded = external || snapshot.requestError || editor.errorCode?.includes('conflict');
  return e('form', { className: 'dpc-page', 'aria-label': title, onSubmit: event => { event.preventDefault(); if (disabled || external || (!dirty && !snapshot.error)) return;
    void work(async () => { const result = await scope.update(editor.draft, editor.base.revision); replace(result); if (alive.current) setEditor(previous => ({ ...previous, saved: true })); });
  } },credentialsFirst?credentialView:null,editor.draft?grouped(false):e('p',null,'正在读取配置…'),
    editor.draft&&fields.some(spec=>spec.advanced&&visible(spec))?e('details',{className:'dpc-advanced'},e('summary',null,'高级设置'),grouped(true)):null,
    snapshot.error ? e('p', { role: 'alert' }, '文件有误，运行时保留上一次有效设置。', snapshot.error.message, '；保存可修复文件。') : null,
    external ? e('p', { role: 'alert' }, '配置已被其他页面或文件编辑修改。重新载入后再保存，可避免覆盖外部修改。') : null,
    editor.error || snapshot.requestError ? e('p', { role: 'alert' }, editor.error || snapshot.requestError) : null,
    e('div', { className: 'dpc-actions' }, e(DshButton, { type: 'submit', variant: 'primary', disabled: disabled || external || (!dirty && !snapshot.error) }, busy ? '处理中…' : '保存'),
      reloadNeeded ? e(DshButton, { type: 'button', variant: 'outline', disabled: busy, onClick: () => void work(async () => replace(await scope.reload())) }, dirty ? '放弃草稿并重新载入' : '重新载入') : null,
      actionLabel ? e(DshButton, { type: 'button', variant: 'outline', disabled: busy || !snapshot.writable, onClick: () => void work(async () => { await scope.runAction(); }) }, actionLabel) : null,
      e('span', { role: 'status' }, editor.saved ? '已保存并生效' : dirty ? '尚未保存' : '')),
    snapshot.details ? e('p', { role: 'status' }, snapshot.details.message) : null,
    e('p', { className: 'dpc-note' }, '保存后自动应用，后续操作使用新配置。'),
    snapshot.configFile ? e('details', { className: 'dpc-path' }, e('summary', null, '配置文件'), e('code', null, snapshot.configFile)) : null,
    credentialsFirst?null:credentialView,
  );
}
function CredentialsPage({ api, refs, writable, title, expanded=false }) {
  const e = React.createElement;
  const [status, setStatus] = React.useState({}), [drafts, setDrafts] = React.useState({}), [busy, setBusy] = React.useState(false), [error, setError] = React.useState('');
  const alive = React.useRef(false), running = React.useRef(false);
  const identity = JSON.stringify(refs);
  React.useEffect(() => {
    let active = true;
    alive.current = true;
    void api.describe(Object.keys(refs)).then(result => {
      if (!active) return;
      if (!result.ok) throw new Error(result.error?.message || '读取凭证状态失败');
      setStatus(result.value);
    }).catch(reason => { if (active) setError(reason.message); });
    return () => { active = false; alive.current = false; };
  }, [api, identity]);
  const save = async (ref, clear) => {
    if (running.current || !writable) return; running.current = true; setBusy(true); setError('');
    try {
      const result = clear ? await api.unset(ref) : await api.set(ref, drafts[ref]);
      if (!result.ok) throw new Error(result.error?.message || '保存凭证失败');
      if (!alive.current) return;
      setDrafts(previous => ({ ...previous, [ref]: '' }));
      setStatus(previous => ({ ...previous, [ref]: { configured: !clear } }));
    } catch (reason) { if (alive.current) setError(reason.message); }
    finally { running.current = false; if (alive.current) setBusy(false); }
  };
  return e(expanded?'section':'details', { className: 'dpc-credentials' }, e(expanded?'h4':'summary', null, title), e('fieldset', { disabled: busy || !writable },
    e('p', null, '密钥单独保存到 DSH 凭证管理；已有密钥只显示配置状态。'),
    Object.entries(refs).map(([ref, label]) => e('div', { className: 'dpc-field', key: ref }, e('label', null, label, ' · ', ref),
      e('input', { type: 'password', autoComplete: 'new-password', 'aria-label': label + ' 密钥', value: drafts[ref] || '', placeholder: status[ref]?.configured ? '已配置；留空保持' : '未配置',
        onChange: event => setDrafts(previous => ({ ...previous, [ref]: event.target.value })) }),
      e('div', { className: 'dpc-actions' }, e(DshButton, { type: 'button', variant: 'outline', disabled: !drafts[ref], onClick: () => void save(ref, false) }, '保存密钥'),
        e(DshButton, { type: 'button', variant: 'ghost', disabled: !status[ref]?.configured, onClick: () => void save(ref, true) }, '清除密钥')))),
    error ? e('p', { role: 'alert' }, error) : null));
}
function installConfigPage(ctx, options) {
  const scope = createConfigScope(ctx.connection, options.endpoint);
  ctx.effect(() => {
    const refresh = () => { void scope.reload().catch(() => {}); };
    refresh(); window.addEventListener?.('focus', refresh);
    if (typeof document === 'undefined') return () => { window.removeEventListener?.('focus', refresh); scope.close(); };
    const style = document.createElement('style'); style.dataset.pluginConfig = options.packageName;
    style.textContent = `
      .dpc-page{max-width:760px;color:var(--dsw-alias-label-primary);font-size:14px}
      .dpc-page p,.dpc-page small{line-height:1.65;color:var(--dsw-alias-label-secondary)}
      .dpc-page [role=alert]{color:var(--dsw-alias-state-error-primary,#d64545)}
      .dpc-group+.dpc-group{margin-top:28px}.dpc-group h4{margin:0 0 8px;font-size:14px;font-weight:600}
      .dpc-field{display:grid;grid-template-columns:minmax(180px,1fr) minmax(160px,280px);gap:24px;padding:18px 0;border-bottom:1px solid var(--dsw-alias-border-l2);align-items:center}
      .dpc-label label{line-height:22px;font-weight:500}.dpc-label small{display:block;margin-top:4px;font-size:12px}
      .dpc-control{min-width:0}.dpc-boolean .dpc-control{justify-self:end}
      .dpc-field input:not([type=checkbox]),.dpc-field select,.dpc-field textarea{box-sizing:border-box;width:100%;padding:9px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:inherit;font:inherit}.dpc-field textarea{resize:vertical;line-height:1.6}
      .dpc-actions{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:24px}
      .dpc-order{margin:0;padding:0;list-style:none;display:grid;gap:4px}.dpc-order li{display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-layer-2)}
      .dpc-rank{font-size:12px;color:var(--dsw-alias-label-tertiary);width:20px;text-align:center;font-variant-numeric:tabular-nums}.dpc-provider-name{flex:1}.dpc-order-actions{display:flex;gap:2px}.dpc-arrow{min-width:28px;padding:0!important}
      .dpc-providers,.dpc-order{grid-template-columns:1fr;gap:12px}.dpc-choice{display:inline-flex;gap:4px;margin:4px 12px 4px 0}
      .dpc-note{font-size:12px}.dpc-path{overflow-wrap:anywhere;margin-top:16px;color:var(--dsw-alias-label-tertiary);font-size:12px}.dpc-path code{display:block;margin-top:8px;user-select:text}
      .dpc-credentials{border-top:1px solid var(--dsw-alias-border-l2);margin-top:24px;padding-top:18px}.dpc-credentials fieldset{border:0;padding:0;min-width:0}.dpc-page summary{cursor:pointer;line-height:22px}
      .dpc-credentials:first-child{border-top:0;margin-top:0;padding-top:0;margin-bottom:28px}.dpc-credentials h4{margin:0;font-size:14px;font-weight:600}
      .dpc-advanced{margin-top:28px;padding:18px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px}.dpc-advanced>summary{font-weight:500}.dpc-advanced[open]>summary{margin-bottom:20px}
      .dpc-credentials .dpc-field{grid-template-columns:140px minmax(0,1fr) auto;gap:14px}.dpc-credentials .dpc-actions{margin:0}
      .dpc-page :is(select,input,textarea):focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:3px}
      [data-plugin-detail="${options.packageName}"] [data-plugin-rows]:has(>ul>[data-plugin-row]:only-child):not(:has([data-state=failed],[data-state=off])){display:none}
      @media(max-width:620px){.dpc-field,.dpc-credentials .dpc-field{grid-template-columns:1fr;gap:10px}.dpc-boolean{grid-template-columns:1fr auto;gap:20px}}
    `;
    document.head.appendChild(style);
    return () => { window.removeEventListener?.('focus', refresh); scope.close(); style.remove(); };
  });
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: options.packageName },
    ({ view }) => view === 'summary' ? options.description : React.createElement(React.Fragment, null,
      options.panel ? React.createElement(options.panel, { scope, connection: ctx.connection }) : null,
      React.createElement(FileConfigPage, { ...options, scope }))));
  return scope;
}

// END GENERATED PLUGIN SETTINGS

function PluginPanel({scope}) {
 const e=React.createElement,snapshot=useFileConfig(scope),[state,setState]=React.useState(null),[busy,setBusy]=React.useState(false),[error,setError]=React.useState(''),[review,setReview]=React.useState(null);
 const alive=React.useRef(false),working=React.useRef(false),timer=React.useRef(null),epoch=React.useRef(0),serial=React.useRef(0);
 const reload=async()=>{const version=epoch.current,sequence=++serial.current,value=await scope.call('status',{});if(alive.current&&version===epoch.current&&sequence===serial.current){setState(value);setReview(current=>{if(!current)return null;const row=value.recovery?.find(row=>row.id===current.id);return row?{...current,...row}:null;});clearTimeout(timer.current);if(value.busy||value.vectorBusy)timer.current=setTimeout(()=>{if(document.visibilityState!=='hidden')void reload().catch(reason=>{if(alive.current&&version===epoch.current)setError(reason.message);});},2000);}return value;};
 React.useEffect(()=>{alive.current=true;const version=++epoch.current;setState(null);setError('');setReview(null);const refresh=()=>{clearTimeout(timer.current);if(document.visibilityState!=='hidden'&&snapshot.status==='ready'&&snapshot.value.enabled)void reload().catch(reason=>{if(alive.current&&version===epoch.current)setError(reason.message);});};refresh();window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',refresh);return()=>{alive.current=false;++epoch.current;clearTimeout(timer.current);window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh);};},[scope,snapshot.revision]);
 const work=async(fn)=>{if(working.current)return;const version=epoch.current;working.current=true;setBusy(true);setError('');try{await fn();if(alive.current&&version===epoch.current)await reload();}catch(reason){if(alive.current&&version===epoch.current)setError(reason.message);}finally{working.current=false;if(alive.current)setBusy(false);}};
 const button=(label,fn,variant='outline',disabled=false)=>e(DshButton,{type:'button',variant,disabled:busy||!snapshot.writable||disabled,onClick:()=>void work(fn)},label);
 const start=kind=>scope.call('startMemory',{kind});
 const source=item=>e('details',{key:item.sessionId+':'+item.seq},e('summary',null,item.sessionId+' #'+item.seq),e('blockquote',null,item.quote));
 const pending=state?.candidates.filter(item=>item.state==='pending')??[],promoted=state?.candidates.filter(item=>item.state==='promoted')??[];
 return e('section',{className:'dpc-page memory-panel','aria-label':'Dream 与长期记忆'},
  e('style',null,'.memory-panel{margin-bottom:32px}.memory-toolbar{display:flex;gap:10px;flex-wrap:wrap}.memory-item{padding:14px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;margin:12px 0}.memory-item p{margin:6px 0}.memory-meta{font-size:12px;color:var(--dsw-alias-label-tertiary)}.memory-panel blockquote{border-left:3px solid var(--dsw-alias-border-l2);padding-left:12px;margin:10px 0;white-space:pre-wrap}.memory-panel table{width:100%;font-size:12px;border-collapse:collapse}.memory-panel td,.memory-panel th{text-align:left;padding:9px;border-bottom:1px solid var(--dsw-alias-border-l2)}.memory-panel code{overflow-wrap:anywhere}'),
  e('div',{className:'memory-toolbar'},button('整理今日记忆',()=>start('daily'),'outline',!!state?.busy),button('Dream 整理',()=>start('dream'),'primary',!!state?.busy),button('复查本周',()=>start('weekly'),'outline',!!state?.busy),state?.busy||state?.vectorBusy?button('取消整理',()=>scope.call('cancel',{})):null),
  error?e('p',{role:'alert'},error):null,state?.scheduleError?e('p',{role:'alert'},'自动任务：'+state.scheduleError):null,state?.workflowError?e('p',{role:'alert'},state.workflowError):null,
  !state?e('p',null,'正在读取记忆状态…'):e(React.Fragment,null,e('p',{className:'memory-meta'},'当前工作区：',e('code',null,state.workspace)),state.busy?e('p',{role:'status'},'正在整理。会使用配置的模型；结果保留在本页的运行记录中。'):null,
   state.recovery?.length?e('section',{'aria-label':'记忆写入恢复'},e('p',{role:'alert'},'有写入需要核对。现有文件会保留，差异审阅后可以重新核对或放弃尚未提交的操作。'),state.recovery.map(row=>e('article',{className:'memory-item',key:row.id},e('p',null,row.file+' · '+row.preset+' · '+({report:'整理报告',promote:'记忆晋升',forget:'遗忘记忆'}[row.kind]??'记忆写入')),e('p',{className:'memory-meta'},row.committed?'记录已提交，暂存内容待核对':row.error??'另一进程正在提交'),button('查看恢复差异',async()=>{const version=epoch.current,value=await scope.call('inspectCommit',{id:row.id});if(alive.current&&version===epoch.current)setReview(value);}))),button('重新核对恢复',()=>scope.call('recheckCommits',{}))):null,
   state.vectorCleanup?e('section',{'aria-label':'向量清理状态'},e('p',{role:'status'},'有 '+state.vectorCleanup+' 项外部向量清理待完成；已遗忘事实不会继续被检索。'),button('重试向量清理',()=>scope.call('retryVectorCleanup',{}))):null,
   e('details',{open:true},e('summary',null,'候选记忆 · '+pending.length),pending.length?pending.map(item=>e('article',{className:'memory-item',key:item.id},e('p',null,item.text),e('p',{className:'memory-meta'},'可信度 '+Math.round(item.confidence*100)+'% · '+item.observations+' 个独立来源'+(item.expired?' · 已过期':'')+(item.conflict?' · 存在同主题冲突，请审阅后决定':'')),e('details',null,e('summary',null,'查看出处'),item.sources.map(source)),e('div',{className:'dpc-actions'},button(item.conflict?'确认更新记忆':'确认晋升',async()=>{if(window.confirm((item.conflict?'将替换同主题的受管记忆，请确认：':'加入 MEMORY.md，请确认：')+item.text))await scope.call('promote',{id:item.id,confirmation:item.id});},'primary',item.expired),button('遗忘候选',async()=>{if(window.confirm('遗忘这条候选及其来源？'))await scope.call('forget',{id:item.id});})))):e('p',null,'尚无待确认候选。整理会话后会显示有出处的稳定事实。')),
   e('details',null,e('summary',null,'已确认记忆 · '+promoted.length),promoted.map(item=>e('article',{className:'memory-item',key:item.id},e('p',null,item.text),item.reviewDue?e('p',{role:'status'},'此记忆已超过复核周期，暂不参与自动召回，请人工确认现状。'):null,e('p',{className:'memory-meta'},'生效：'+(item.validFrom?new Date(item.validFrom).toLocaleDateString():'旧版本')+(item.reviewedAt?' · 最近核验：'+new Date(item.reviewedAt).toLocaleDateString():'')),e('details',null,e('summary',null,'查看出处'),item.sources.map(source)),button('确认仍有效',async()=>{if(window.confirm('已人工核对这条事实目前仍然成立？'+item.text))await scope.call('reaffirm',{id:item.id,confirmation:item.id});},'outline'),button('遗忘记忆',async()=>{if(window.confirm('从 MEMORY.md 移除这条受管记忆并遗忘来源？'))await scope.call('forget',{id:item.id});})))),
   e('details',null,e('summary',null,'向量检索'),e('p',{className:'memory-meta'},'已注册提供方：'+(state.vectorProviders.join('、')||'暂未注册，使用词语检索')),e('p',{className:'memory-meta'},'可用存储：'+(state.vectorStores??['sqlite']).join('、')),snapshot.value.embeddingProvider?button(state.vectorBusy?'正在更新索引…':'重建向量索引',()=>scope.call('startRebuildVectors',{}),'outline',!!state.vectorBusy):null,state.vectorResult?e('p',{role:state.vectorResult.error?'alert':'status'},state.vectorResult.error??('已索引 '+state.vectorResult.indexed+' 条，更新 '+state.vectorResult.updated+' 条')):null),
   e('details',null,e('summary',null,'自动任务与执行记录'),
    button('核对自动任务记录',()=>scope.call('recheckWorkflows',{})),
    e('p',{className:'memory-meta'},'核对原生会话与投递记录，保留已提交产物；中断的模型作业需审阅后手动整理。'),
    state.schedules.map(task=>e('p',{className:'memory-meta',key:task.id},task.title+' · '+task.status+' · 下一次 '+new Date(task.scheduledAt).toLocaleString())),
    (state.templates??[]).map(row=>e('article',{className:'memory-item',key:row.id},e('p',null,({daily:'每日记忆',dream:'Dream',weekly:'每周复查'}[row.kind]??row.kind)+' · '+({ready:'计划已就绪',new:'待创建',creating:'创建待核对',updating:'修改待核对',deleting:'删除待核对',removed:'计划已移除','needs-review':'计划需核对'}[row.state]??row.state)),row.note?e('p',{role:'status'},row.note):null,row.historyIncomplete?e('p',{className:'memory-meta'},'原生投递历史部分不可用；已保存 '+row.receipts+' 条摘要，执行结果仍以原生会话和产物为依据。'):null)),
    (state.workflows??[]).length?e('section',{'aria-label':'自动任务执行账本'},e('h4',null,'原生轮次'),(state.workflows??[]).map(row=>e('article',{className:'memory-item',key:row.id},e('p',null,({daily:'每日记忆',dream:'Dream',weekly:'每周复查'}[row.kind]??row.kind)+' · '+({delivered:'已投递，等待执行',running:'运行中','awaiting-user':'等待你的回答','awaiting-approval':'等待原生审批',completed:'已完成',failed:'失败',cancelled:'已取消',interrupted:'已中断','needs-review':'需核对'}[row.state]??row.state)),e('p',{className:'memory-meta'},'计划时间：'+new Date(row.occurrence).toLocaleString()),row.note?e('p',{role:'status'},row.note):null,(row.result?.artifacts??[]).map(artifact=>e('p',{key:artifact.path},artifact.path))))):null,
    e('h4',null,'记忆作业'),e('table',null,e('thead',null,e('tr',null,e('th',null,'任务'),e('th',null,'状态'),e('th',null,'时间 / 产物'))),e('tbody',null,state.runs.map(run=>e('tr',{key:run.id},e('td',null,{daily:'每日记忆',dream:'Dream',weekly:'每周复查'}[run.kind]??run.kind),e('td',null,{completed:'已完成',running:'执行中',failed:'失败',cancelled:'已取消',interrupted:'已中断'}[run.state]??run.state),e('td',null,new Date(run.started).toLocaleString(),run.result?.error?e('p',{role:run.state==='failed'?'alert':'status'},run.state==='cancelled'?'已取消本次整理。':run.result.error):null,(run.result?.artifacts??[]).map(artifact=>e('p',{key:artifact.path},artifact.path)),run.result?.empty?e('p',null,'没有新材料'):null,run.result?.deduplicated?e('p',null,'材料未变，已复用结果'):null)))))),
  ),
  review?e('section',{'aria-label':'记忆恢复差异'},
   e('h4',null,review.file+' · 恢复审阅'),
   [['before','写入前'],['after','本次预期内容'],['current','当前文件']].map(([key,label])=>e('details',{key,open:key==='current'},
    e('summary',null,label),e('pre',{style:{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:360,overflow:'auto'}},review[key]??'（文件不存在）')
   )),
   e('div',{className:'dpc-actions'},!review.committed?button('保留当前文件并放弃操作',async()=>{
    if(window.confirm('保留当前文件，放弃这次尚未提交的记忆操作？候选记录不会按这次操作更新。')){await scope.call('discardCommit',{id:review.id,confirmation:review.id});setReview(null);}
   }):null,button('关闭恢复审阅',async()=>setReview(null)))
  ):null,
  e('p',{className:'memory-meta'},'Daily 写入 memory/日期.md，Dream 写入 DREAMS.md；确认后的事实写入 MEMORY.md。人工内容会保留。'),
 );
}

return { inject: ['slots', 'connection'], apply(ctx) { installConfigPage(ctx, { ...{"rowId":"memory-dreaming","endpoint":"memoryDreaming","standalone":true,"title":"Dream 与长期记忆","description":"从原生会话整理日常记忆、Dream 与每周复查，保留出处并审阅长期事实。","fields":[{"key":"workspace","label":"工作区","type":"text","help":"留空时使用客户端默认工作区。"},{"key":"agentPreset","label":"对应 Agent 预设","type":"text","help":"只读取此预设在所选工作区的会话，默认 agent。"},{"key":"recall","label":"启用长期记忆检索","type":"boolean"},{"key":"autoRecall","label":"按当前问题自动召回可信事实","group":"跨会话召回","type":"boolean","help":"主人由 Channel Core 认领并核验；两渠道共用会话仍需在 Channel Core 关联身份。其他人的私聊与群聊不会召回个人记忆。"},{"key":"autoRecallMaxItems","label":"每次自动召回最多几条","group":"跨会话召回","type":"number","min":1,"max":5,"when":{"autoRecall":true},"help":"默认最多 3 条。召回只在有明显关键词命中时触发。"},{"key":"autoRecallMaxChars","label":"召回总文本预算（字符）","group":"跨会话召回","type":"number","min":200,"max":4000,"when":{"autoRecall":true},"help":"默认 1200 字符。已确认记忆在 MEMORY.md 持久化；这里只附加相关事实，不追加全量历史。"},{"key":"autoPromote","label":"自动晋升高质量候选","type":"boolean","help":"默认关闭。开启后，只晋升出处仍有效、达到可信度和独立观察次数且无冲突的事实。"},{"key":"minConfidence","label":"自动晋升最低可信度","type":"number","min":0.5,"max":1,"step":"any"},{"key":"minObservations","label":"自动晋升最低独立观察次数","type":"number","min":1,"max":20,"help":"同一条消息重复整理不会增加观察次数。","step":1},{"key":"candidateDays","label":"候选有效期（天）","type":"number","min":7,"max":3650,"step":1},{"key":"memoryReviewDays","label":"已发布事实复核周期（天）","group":"记忆新鲜度","type":"number","min":30,"max":3650,"help":"默认 180 天。到期的长期事实保留在 MEMORY.md，但暂停自动召回，等待你确认它依然有效；手动检索仍可看到并标记待复核。"},{"key":"incremental","label":"仅整理尚未处理的新消息","group":"增量 Dream","type":"boolean","help":"按每个任务种类记录成功处理的 Session 消息序号。失败或中断不会标记已处理；关闭后允许重新整理完整时间窗。"},{"key":"automatic","label":"自动日常记忆、Dream 与每周复查","type":"boolean","help":"使用官方自动任务；开启后会按时调用模型，并在原生会话保留执行过程。"},{"key":"timeZone","label":"任务时区","type":"text","help":"例如 Asia/Shanghai。"},{"key":"dailyTime","label":"每日记忆时间","type":"text","help":"HH:mm:ss"},{"key":"dreamTime","label":"Dream 整理时间","type":"text","help":"HH:mm:ss"},{"key":"weeklyTime","label":"每周复查时间","type":"text","help":"HH:mm:ss"},{"key":"weeklyDay","label":"每周复查日期","type":"select","numeric":true,"options":[[1,"星期一"],[2,"星期二"],[3,"星期三"],[4,"星期四"],[5,"星期五"],[6,"星期六"],[7,"星期日"]]},{"key":"model","providerKey":"modelProvider","label":"整理模型","type":"model"},{"key":"maxOutputTokens","label":"单次整理最大输出 token","type":"number","min":256,"max":16384,"step":1},{"key":"maxInputTokens","label":"单次整理输入 token 上限","type":"number","min":1000,"max":65536,"help":"同时受实际模型窗口限制。","step":1},{"key":"maxSessions","label":"每轮最多扫描会话数","type":"number","min":1,"max":100,"step":1},{"key":"maxCandidates","label":"每工作区最多有效候选数","type":"number","min":10,"max":5000,"step":1},{"key":"embeddingModel","providerKey":"embeddingProvider","kind":"embedding","label":"Embedding 模型","type":"model","help":"从已注册的向量模型选择；提供方不可用时回退到词语检索。"},{"key":"vectorStore","label":"向量存储 ID","type":"text","help":"默认 sqlite；可由其他插件提供替代存储。"}],"packageName":"dsh-memory-dreaming"}, panel: PluginPanel,  }); } };
} });
