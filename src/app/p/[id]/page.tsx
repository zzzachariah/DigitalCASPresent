import { notFound } from "next/navigation";
import { getPerson, toPublic } from "@/lib/store";
import { canView } from "@/lib/access";
import { didStreamEnabled } from "@/lib/did-stream";
import VisitorExperience from "@/components/VisitorExperience";
import Unpublished from "@/components/Unpublished";

export const dynamic = "force-dynamic";

export default async function VisitorPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams?: { preview?: string | string[] };
}) {
  const person = await getPerson(params.id);
  if (!person) notFound();

  // Unpublished (student-submitted, not yet approved) pages are visible only
  // to the student with their edit token (?preview=…) or to a logged-in admin.
  const raw = searchParams?.preview;
  const previewToken = Array.isArray(raw) ? raw[0] : raw;
  if (!canView(person, previewToken)) return <Unpublished name={person.name} />;

  // Real-time talking avatar is available only if D-ID is configured AND the
  // person has a (public) photo for the stream source.
  const avatarStream = didStreamEnabled() && !!person.photoUrl;
  return (
    <VisitorExperience
      person={toPublic(person)}
      avatarStream={avatarStream}
      previewToken={previewToken}
    />
  );
}
