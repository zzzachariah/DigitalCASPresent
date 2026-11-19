import type { Metadata } from "next";
import Link from "next/link";
import { PRIVACY_VERSION } from "@/lib/privacy";
import { eventRetentionStatus } from "@/lib/event-retention";
import { externalProcessingAllowed } from "@/lib/processing-policy";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "隐私协议 · Privacy agreement",
  robots: { index: false, follow: false },
};

export default function PrivacyPage() {
  const retention = eventRetentionStatus();
  const ends = retention.endsAt ? new Date(retention.endsAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : null;
  const external = externalProcessingAllowed();
  const terms = [
    {
      title: "1. 用途与保密 · Purpose and confidentiality",
      zh: "本项目由活动组织者用于 TOK 展览准备和现场讲解。未评分讲稿及其分段按保密资料处理，不提供给其他学生浏览、下载或用于评分，不出售、不用于广告，也不授权将其用于模型训练。仅资料提交者、持有其私人修改链接的人及经授权的活动管理人员可访问原稿；请不要共享该链接。",
      en: "The organizer uses this project to prepare and present the TOK exhibition. Ungraded manuscripts and their sections are confidential: they are not offered to other students for browsing, downloading or grading, sold, used for advertising, or authorized for model training. Original text is available only to the submitter, holders of their private edit link and authorized event administrators. Do not share that link.",
    },
    {
      title: "2. 收集哪些资料 · What is collected",
      zh: "提交所需资料包括姓名、照片、讲稿、分段、回答语言、声音选择，以及可选的班级/小组和副标题。本站记录隐私协议版本及服务器确认时间，用于证明提交时接受的条款。上传的文档仅用于提取文字，本站不另行保存原始文档文件；提取后的文字随提交资料保存。不要上传身份证号、联系方式或与展览无关的敏感个人信息。",
      en: "We collect your name, photo, manuscript, sections, language and voice preferences, plus optional class/group and subtitle. The accepted policy version and server timestamp are stored with the submission. Uploaded documents are used to extract text; the original document file is not separately stored by this app. Extracted text is saved with the submission. Do not include identity numbers, contact details or unrelated sensitive information.",
    },
    {
      title: "3. 展示范围 · What visitors may see",
      zh: "资料须经老师审核发布后才对访客开放。发布的姓名、展示标题、照片或形象以及经审核的有限讲解可能被访客看到或听到；展览讲解必然会披露其中的部分观点，因此请先与老师确认适合展示的范围。原稿和整篇文章不作为公开下载资料。私人预览链接可查看未发布展示，也必须保密。",
      en: "Visitors can access a presentation only after teacher approval. Published names, exhibition titles, photos or avatars, and limited reviewed explanations may be seen or heard by visitors. Presenting necessarily reveals some ideas, so agree the appropriate scope with your teacher first. Manuscripts and full essays are not offered as public downloads. A private preview link can show unpublished presentation material and must also be kept confidential.",
    },
    {
      title: "4. AI 与服务商 · AI and service providers",
      zh: "本站使用托管及存储服务运行。外部 AI、语音及形象处理默认关闭；只有组织者审核服务商的数据保留、训练使用和删除条件并批准后才能启用。接受本协议不代替该审核，也不构成训练授权。启用后，准备讲解所必需的文字、生成语音所需的讲解或形象生成所需的照片可能传给相应服务商。本站无法独立保证所有服务商不留存数据，或替其完成删除；组织者必须在启用前确认这些安排。",
      en: "Hosting and storage services operate this app. External AI, speech and avatar processing is disabled by default and requires the organizer to review and approve provider retention, training-use and deletion terms. Accepting this agreement does not replace that review or authorize training. When enabled, the necessary text, narration or photograph may be processed by the relevant provider. This app cannot independently guarantee that every provider retains no data or delete it on their behalf; the organizer must confirm those arrangements before enabling them.",
    },
    {
      title: "5. 活动结束后的销毁 · Deletion after the event",
      zh: "组织者须设置活动结束时间并确认清理完成。到达该时间后，本项目关闭投稿、原稿读取、预览、公开展示及 AI 交互；接下来的定时清理会删除本站存储中的讲稿、分段、照片、音视频、修改令牌和同意记录，通常在下一次每日清理时完成。任务失败时须由管理人员重试并核查。销毁不等于撤回他人已保存的截图、导出文件、浏览器缓存或服务商副本；这些副本应由持有人或服务商按约定删除。",
      en: "The organizer must set the event end time and verify cleanup. At that time, submission, original-text access, previews, public presentations and AI interactions close. The next scheduled cleanup removes manuscripts, sections, photos, audio/video, edit tokens and consent records from this app’s stores, normally at the next daily run. Administrators must retry and verify failed cleanup. Deletion does not recall screenshots, exports, browser caches or provider copies already held elsewhere; their holders or providers must delete them under the agreed arrangements.",
    },
    {
      title: "6. 你的设备与请求 · Your device and requests",
      zh: "草稿及本次浏览器会话记住的修改链接使用会话存储；请使用自己的设备，提交完成后退出页面，并按需清除网站数据。浏览器的会话恢复功能可能保留会话资料，服务器无法远程擦除你设备上的文件。需要更正、撤回、提前删除，或对条款有疑问时，请直接联系发放本提交链接的老师或活动组织者；不同意时请勿上传，并向老师申请其他提交方式。",
      en: "Drafts and remembered edit links use browser session storage. Use your own device, close the page after submitting, and clear site data when appropriate. Browser session restoration can retain session data; the server cannot remotely erase files on your device. For correction, withdrawal, early deletion or questions, contact the teacher or organizer who supplied this submission link. If you do not agree, do not upload and ask your teacher for an alternative.",
    },
  ];
  return (
    <main className="mx-auto max-w-3xl px-5 py-8 lg:py-12">
      <Link href="/submit" className="text-sm text-accent hover:underline">返回提交 · Back to submission</Link>
      <h1 className="mt-6 text-3xl font-semibold">隐私协议 · Privacy agreement</h1>
      <p className="mt-2 text-sm text-ink-3">版本 / Version {PRIVACY_VERSION}</p>
      <aside className="my-6 space-y-2 rounded-lg bg-surface-2 p-5 text-sm leading-relaxed">
        <p><b>活动结束时间 / Event ends:</b> {ends ? `${ends}（北京时间 / Beijing time）` : "尚未配置有效时间，请向老师确认销毁安排。 / No valid time is configured; confirm deletion arrangements with your teacher."}</p>
        <p><b>外部处理 / External processing:</b> {external ? "组织者已启用。 / Enabled by the organizer." : "关闭；自动分段在本站处理，不向 AI 服务商发送讲稿。 / Disabled; automatic splitting runs in this app without sending manuscripts to an AI provider."}</p>
      </aside>
      <div className="space-y-7">
        {terms.map((term) => (
          <section key={term.title}>
            <h2 className="text-lg font-semibold">{term.title}</h2>
            <p className="mt-2 text-[15px] leading-relaxed text-ink-2">{term.zh}</p>
            <p className="mt-2 text-sm leading-relaxed text-ink-3">{term.en}</p>
          </section>
        ))}
      </div>
    </main>
  );
}
