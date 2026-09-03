import type { Metadata } from "next";
import SubmitApp from "@/components/SubmitApp";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "提交讲稿 · Submit your talk",
};

export default function SubmitPage() {
  return <SubmitApp />;
}
