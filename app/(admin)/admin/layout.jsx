import { getAdmin } from "@/actions/admin";
import Header from "@/components/header";
import { notFound } from "next/navigation";
import SideBar from "./_components/sidebar";

export default async function AdminLayout({ children }) {
  const admin = await getAdmin();
  if (!admin.authorized) {
    return notFound();
  }
  return (
    <div className="h-full">
      <Header isAdminPage={true} />
      <div className="flex h-full w-56 flex-col top-20 fixed inset-y-0 z-50">
        <SideBar />
      </div>
      <main className="md:pl-56 pt-20 h-full">{children}</main>
    </div>
  );
}
