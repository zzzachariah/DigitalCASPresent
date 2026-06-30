import { notFound } from "next/navigation";
import { getPerson, toPublic } from "@/lib/store";
import { didStreamEnabled } from "@/lib/did-stream";
import VisitorExperience from "@/components/VisitorExperience";

export const dynamic = "force-dynamic";

export default async function VisitorPage({
  params,
}: {
  params: { id: string };
}) {
  const person = await getPerson(params.id);
  if (!person) notFound();
  // Real-time talking avatar is available only if D-ID is configured AND the
  // person has a (public) photo for the stream source.
  const avatarStream = didStreamEnabled() && !!person.photoUrl;
  return <VisitorExperience person={toPublic(person)} avatarStream={avatarStream} />;
}
