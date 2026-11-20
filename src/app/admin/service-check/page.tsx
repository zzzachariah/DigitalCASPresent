import { redirect } from "next/navigation";
import { isAdmin } from "@/lib/auth";
import AdminServiceCheck from "@/components/AdminServiceCheck";

export const dynamic = "force-dynamic";

export default function ServiceCheckPage() {
  if (!isAdmin()) redirect("/admin/login");
  return <AdminServiceCheck configuredModel={process.env.AI_MODEL || "claude-sonnet-5"} configuredReviewMode={process.env.AI_REVIEW_FORMAT || "json_schema"} />;
}
