import type { Metadata } from "next";
import SubmitApp from "@/components/SubmitApp";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "修改我的提交 · Edit submission",
};

export default function EditSubmissionPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams?: { token?: string | string[] };
}) {
  const raw = searchParams?.token;
  const token = Array.isArray(raw) ? raw[0] : raw;
  return <SubmitApp id={params.id} token={token} />;
}
