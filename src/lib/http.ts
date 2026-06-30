// Safe response parsing for client fetches. An empty body or an HTML error
// page would make res.json() throw "JSON.parse: unexpected end of data"; this
// returns a usable object with a readable `error` instead.
export async function readJson(res: Response): Promise<any> {
  const text = await res.text().catch(() => "");
  if (!text) {
    return res.ok ? {} : { error: `服务器无响应 (${res.status})，请稍后重试` };
  }
  try {
    return JSON.parse(text);
  } catch {
    const snippet = text
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200);
    return { error: snippet || `请求失败 (${res.status})` };
  }
}
