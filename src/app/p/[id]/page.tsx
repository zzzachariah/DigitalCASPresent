import { notFound } from "next/navigation";
import { getPerson, toPublic } from "@/lib/store";
import VisitorExperience from "@/components/VisitorExperience";

export const dynamic = "force-dynamic";

export default async function VisitorPage({
  params,
}: {
  params: { id: string };
}) {
  const person = await getPerson(params.id);
  if (!person) notFound();
  return <VisitorExperience person={toPublic(person)} />;
}
