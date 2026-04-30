import { Timesheet } from "./timesheet";

export const metadata = {
  title: "Time · Pace",
};

export default async function TimePage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>;
}) {
  const params = await searchParams;
  return <Timesheet initialWeek={params.week} />;
}
