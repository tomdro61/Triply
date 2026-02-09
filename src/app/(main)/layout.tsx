import "../globals.css";
import { CookieBanner } from "@/components/shared";

export default function MainLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      {children}
      <CookieBanner />
    </>
  );
}
