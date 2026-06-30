import { redirect } from "next/navigation";
import { isAdmin } from "@/lib/auth";
import AdminApp from "@/components/AdminApp";

export const dynamic = "force-dynamic";

export default function AdminPage() {
  if (!isAdmin()) redirect("/admin/login");
  return <AdminApp />;
}
