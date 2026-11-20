import type { Metadata } from "next";
import Link from "next/link";
import { PRIVACY_VERSION } from "@/lib/privacy";
import { eventRetentionStatus } from "@/lib/event-retention";
import { aiProcessingAllowed } from "@/lib/processing-policy";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "隐私协议 · Privacy agreement",
  robots: { index: false, follow: false },
};

export default function PrivacyPage() {
  const retention = eventRetentionStatus();
  const ends = retention.endsAt ? new Date(retention.endsAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : null;
  const textAi = aiProcessingAllowed();
  const terms = [
    {
      title: "1. 用途与保密 · Purpose and confidentiality",
      zh: "本项目由活动组织者用于 TOK 展览准备和现场讲解。未评分讲稿及其分段按保密资料处理，不提供给其他学生浏览、下载或用于评分，不出售、不用于广告，也不授权将其用于模型训练。本站的原稿访问限于资料提交者、持有其私人修改链接的人及经授权的活动管理人员；经同意的 Packy 及上游文字 AI 处理另见第 4 条。请不要共享私人链接。",
      en: "The organizer uses this project to prepare and present the TOK exhibition. Ungraded manuscripts and their sections are confidential: they are not offered to other students for browsing, downloading or grading, sold, used for advertising, or authorized for model training. Access to original text within this app is limited to the submitter, holders of their private edit link and authorized event administrators. Agreed text AI processing by Packy and upstream providers is described in section 4. Do not share private links.",
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
      zh: "本站使用托管及存储服务运行。组织者已批准通过 Packy 及其上游服务商进行文字 AI 处理，并接受上游保留期限尚未公开确认的限制。你同意后，自动分段可发送讲稿全文；讲解、问答及回答审查可发送所选段落、必要的展示信息、提问和候选回答。Packy 的条款声明其自身不保留输入/输出正文、不将客户内容用于模型训练，但会保留用量等元数据；上游服务商依其自身条款处理和保留数据，不能据此承诺上游零留存。本站及组织者不能保证上游在活动结束日或本站清理日同步删除副本。本次同意仅涵盖上述文字处理，不授权模型训练，也不包含向 A2E、D-ID 发送照片、语音或形象资料；未单独获准的照片处理保持关闭；组织者另行明确指定并单独获准的资料，仅可将对应照片及生成的形象发送给 A2E 制作卡通和动态视频，不因此授权处理其他同学的照片。配音采用独立授权：仅另行获准的指定参与者，其经过审核的有限讲解可发送给 A2E 生成语音，不发送讲稿全文，不采集或克隆本人声音，也不授权其他参与者的配音。未单独获准的配音及 D-ID 保持关闭。AI 回答有内容限制与审查，无法确认时应礼貌表示“这个问题再想想”，但仍不能保证每次回答完全准确。",
      en: "Hosting and storage services operate this app. The organizer has approved text AI processing through Packy and its upstream providers, accepting that upstream retention periods have not been publicly confirmed. With your agreement, automatic splitting may send the full manuscript; explanations, Q&A and answer review may send the selected section, necessary exhibition details, the question and a candidate answer. Packy states that it does not retain input/output content or train models on customer content, while retaining usage metadata. Upstream providers process and retain data under their own terms; this is not a promise of zero upstream retention. Neither this app nor the organizer can guarantee upstream copies are deleted on the event end date or this app’s cleanup date. This agreement covers only the text processing described here. It does not authorize model training or sending photos, speech or avatar material to A2E or D-ID. Photo processing remains disabled unless separately approved for a specifically identified participant. That separate approval permits only the corresponding photo and generated portrait to be sent to A2E to create a cartoon and ambient video; it does not authorize other students’ photos. Speech requires separate approval: only the specifically approved participant’s reviewed, limited explanations may be sent to A2E for narration. The full manuscript is not sent for speech, no personal voice is collected or cloned, and other participants’ speech is not authorized. Unapproved speech generation and D-ID remain disabled. AI answers are constrained and reviewed, with a polite response when an answer cannot be confirmed, but accuracy cannot be guaranteed for every reply.",
    },
    {
      title: "5. 活动结束后的销毁 · Deletion after the event",
      zh: "组织者须设置活动结束时间并确认清理完成。到达该时间后，本项目关闭投稿、原稿读取、预览、公开展示及 AI 交互；接下来的定时清理会删除本站存储中的讲稿、分段、照片、音视频、修改令牌和同意记录，通常在下一次每日清理时完成。任务失败时须由管理人员重试并核查。销毁不等于撤回他人已保存的截图、导出文件、浏览器缓存或服务商副本；这些副本应由持有人或服务商按其适用条款处理；特别是上游 AI 的保留和删除时间未公开确认，本站的销毁计划不代表其同步销毁承诺。",
      en: "The organizer must set the event end time and verify cleanup. At that time, submission, original-text access, previews, public presentations and AI interactions close. The next scheduled cleanup removes manuscripts, sections, photos, audio/video, edit tokens and consent records from this app’s stores, normally at the next daily run. Administrators must retry and verify failed cleanup. Deletion does not recall screenshots, exports, browser caches or provider copies already held elsewhere; those copies remain subject to their holders’ or providers’ applicable terms. In particular, upstream AI retention and deletion timing have not been publicly confirmed; this app’s deletion schedule does not promise simultaneous upstream deletion.",
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
        <p><b>Packy 文字 AI / Packy text AI:</b> {textAi ? "已启用；接受新版协议后按第 4 条处理。 / Enabled; processing follows section 4 after acceptance of this agreement." : "当前关闭；自动分段在本站完成。 / Currently disabled; automatic splitting runs within this app."}</p>
        <p><b>照片与形象 / Photos and avatars:</b> 仅单独获准的指定资料可用于生成卡通和视频；本文字 AI 协议不包含照片授权。 / Only specifically approved material may be used for cartoons and videos; this text AI agreement does not authorize photo processing.</p>
        <p><b>外部配音 / External speech:</b> 仅单独获准的指定参与者可将审核后的有限讲解交给 A2E 配音；照片授权不自动包含配音，不发送全文或克隆声音。 / Only separately approved participants’ reviewed, limited explanations may go to A2E for narration. Photo approval does not include speech; no full manuscript or voice cloning is involved.</p>
      </aside>
      <div className="space-y-7">
        {terms.map((term) => (
          <section key={term.title}>
            <h2 className="text-lg font-semibold">{term.title}</h2>
            <p className="mt-2 text-[15px] leading-relaxed text-ink-2">{term.zh}</p>
            <p className="mt-2 text-sm leading-relaxed text-ink-3">{term.en}</p>
            {term.title.startsWith("4.") && (
              <p className="mt-3 text-sm text-accent">
                服务商条款 / Provider terms: <a href="https://www.packyapi.ai/terms" target="_blank" rel="noreferrer" className="underline">Packy 服务条款</a>{" · "}
                <a href="https://www.packyapi.ai/dpa" target="_blank" rel="noreferrer" className="underline">Packy 数据处理附录（DPA）</a>
              </p>
            )}
          </section>
        ))}
      </div>
    </main>
  );
}
