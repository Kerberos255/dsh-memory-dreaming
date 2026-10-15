/**
 * Editable content priorities. These are NOT the model protocol or security
 * boundary; mandatory JSON/schema/provenance rules remain in memory-batches.
 */
export const MEMORY_PROMPT_DEFAULTS=Object.freeze({
 daily: '按明确的项目/任务名称记录当日进展、验证结果和下一步。状态使用“计划中／进行中／受阻／已完成／已取消”，只描述该日期及来源明确说出的状态，不要将计划当成果。保留关键命令、配置、决定及其原因，区分已验证和猜测；没有可靠状态就写“未确认”。尽量为每个状态写明具体事项名称，方便以后匹配后续更新。不要因记录“未完成”而断言它在未来仍未完成。',
 dream: '只提炼跨会话仍有长期价值的偏好、已确认决定、可复用技术经验和反复出现的问题。优先与既有事实去重、识别新旧冲突与信息是否过期。一次性待办、进行中状态和日期限定的进度应放在日记而非当作永久事实。任何“已完成”“已修复”结论都必须有明确原始来源；发现新方案替代旧决定时记下变化与原因。',
 weekly: '按具体项目和任务串联本周每日日志，分别标注本周新增、推进、阻塞、完成、取消和重新开启的事项。状态变化应附原始日记的日期，不得用周末时间冒充单个事件发生日。对同一事项保留从早到晚的时间线，最新证据优先；相互矛盾或证据不足时明确“待核实”。突出重要决定及原因、已验证结果、未完成事项与下一步，但不能从缺少记录推断事项仍在进行。'
});
export function memoryPrompt(kind,config={}){
 const custom=config[kind+'Prompt'];
 return typeof custom==='string'?custom:MEMORY_PROMPT_DEFAULTS[kind]??'';
}
