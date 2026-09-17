export type MentionKind = "file" | "skill" | "connector";

/** 输入框引用（@文件 / /技能 / $连接器）。id 口径与后端候选端点一致：file = "runtime:<relPath>" */
export interface Mention {
  kind: MentionKind;
  id: string;
  label: string;
}

export const MENTION_TRIGGERS: Record<MentionKind, string> = {
  file: "@",
  skill: "/",
  connector: "$",
};

export function mentionMarker(m: Mention): string {
  return `${MENTION_TRIGGERS[m.kind]}${m.label}`;
}

/**
 * 发送前对账：用户选中后又删除了文本中的标记的引用不再上送。
 * mentions 仅是发送时的临时指令（不落库），文本标记即唯一事实源。
 */
export function reconcileMentions(text: string, mentions: readonly Mention[]): Mention[] {
  return mentions.filter((m) => text.includes(mentionMarker(m)));
}

export interface MentionToken {
  type: "text" | "mention";
  text: string;
  kind?: MentionKind;
}

/** 标记体的首字符：字母/中文（排除 $100 金额、@2 点坐标这类误伤） */
const BODY_FIRST = /[A-Za-z\u4e00-\u9fff]/;
/** @ 的体可含路径斜杠与点；/ 和 $ 的体不允许斜杠（技能/连接器名不含 /，路径中的 /usr/local 不误判） */
const FILE_BODY = /[A-Za-z0-9_\-./\u4e00-\u9fff]/;
const NAME_BODY = /[A-Za-z0-9_\-\u4e00-\u9fff]/;

function matchMentionBody(text: string, start: number, trigger: string): string | null {
  const first = text[start] ?? "";
  if (!BODY_FIRST.test(first)) return null;
  const rest = trigger === "@" ? FILE_BODY : NAME_BODY;
  let end = start;
  while (end < text.length && rest.test(text[end] ?? "")) end += 1;
  return text.slice(start, end);
}

/** 用户消息高亮分词：仅识别词首的 @/​/$ 标记（邮箱 a@b.com、普通文本不误伤） */
export function tokenizeMentionMarkers(text: string): MentionToken[] {
  const tokens: MentionToken[] = [];
  let plain = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i] ?? "";
    const prev = i > 0 ? (text[i - 1] ?? "") : "";
    const atWordStart = prev === "" || /\s/.test(prev);
    const isTrigger = (ch === "@" || ch === "/" || ch === "$") && atWordStart;
    const body = isTrigger ? matchMentionBody(text, i + 1, ch) : null;
    if (body !== null && body.length > 0) {
      if (plain) {
        tokens.push({ type: "text", text: plain });
        plain = "";
      }
      tokens.push({
        type: "mention",
        text: `${ch}${body}`,
        kind: ch === "@" ? "file" : ch === "/" ? "skill" : "connector",
      });
      i += 1 + body.length;
    } else {
      plain += ch;
      i += 1;
    }
  }
  if (plain) tokens.push({ type: "text", text: plain });
  return tokens;
}
