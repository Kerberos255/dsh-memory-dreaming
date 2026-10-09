/** Explain a provider-neutral model failure without leaking adapter error text,
 * request payloads, credentials, HTTP headers or private conversation content.
 */
const codeHints={
 AUTH:'模型服务认证失败；检查 DSH 中该提供方的登录状态或 API 凭证',
 INVALID_CREDENTIAL:'模型服务拒绝当前凭证；检查 DSH 保存的凭证是否有效',
 MISSING_CREDENTIAL:'模型服务缺少凭证；检查 DSH 中该提供方的凭证设置',
 QUOTA:'模型额度或余额不足，请检查提供方账户余额',
 ACCOUNT_QUOTA:'账户额度不足，请检查提供方账户余额',
 RATE_LIMIT:'模型服务限流；请稍后重试或降低调用频率',
 SERVER:'模型服务端错误；稍后重试',
 TIMEOUT:'模型请求超时；检查网络与服务状态',
 TRANSPORT:'模型网络连接失败；检查代理和提供方连接',
 CONTEXT_WINDOW_EXCEEDED:'模型上下文容量不足；应缩小单批输入',
 NO_ADAPTER:'DSH 未找到这个模型的有效适配器',
 EMPTY_RESPONSE:'模型服务返回了空响应',
 ABORTED:'模型请求已被中止'
};
const statusHint={400:'模型请求参数不被服务端接受',401:'模型认证失败',402:'模型账户可能余额不足',403:'模型访问被拒绝',404:'请求的模型或 API 地址不存在',408:'请求超时',413:'请求过大',429:'模型服务限流或额度受限',500:'模型服务内部错误',502:'模型服务网关异常',503:'模型服务暂不可用',504:'模型服务响应超时'};
export function modelStreamFailureMessage(failure){
 const raw=typeof failure?.code==='string'?failure.code:'UNKNOWN';
 const code=/^[A-Z][A-Z0-9_]{0,48}$/.test(raw)?raw:'UNKNOWN';
 const status=Number.isInteger(failure?.status)&&failure.status>=100&&failure.status<=599?failure.status:null;
 const hint=codeHints[code]??statusHint[status]??'模型适配器返回失败，请核对模型名称、服务状态和 DSH 日志';
 return '记忆模型调用失败：'+hint+'（错误代码 '+code+(status===null?'':'，HTTP '+status)+'）。';
}
