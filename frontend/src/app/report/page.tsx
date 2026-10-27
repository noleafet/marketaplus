import TradeReport from "@/features/report/trade-report";

type ReportSearchParams = {
  token?: string;
  interval?: string;
  time?: string;
  exchange?: string;
  subject?: string;
};

export default async function ReportPage({
  searchParams,
}: {
  searchParams: Promise<ReportSearchParams>;
}) {
  const params = await searchParams;
  return (
    <TradeReport
      token={params.token ?? ""}
      interval={params.interval ?? ""}
      time={params.time ?? ""}
      exchange={params.exchange}
      subject={params.subject}
    />
  );
}
