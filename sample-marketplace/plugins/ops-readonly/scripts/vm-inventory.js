const project = process.env.AVATAR_CHAT_PROJECT_SCOPE || "default-project";

const rows = [
  {
    name: "app-01",
    role: "application",
    cpu: "4 vCPU",
    memory: "8 GiB",
    network: "internal",
    project
  },
  {
    name: "batch-01",
    role: "batch worker",
    cpu: "8 vCPU",
    memory: "16 GiB",
    network: "internal",
    project
  },
  {
    name: "db-read-01",
    role: "read replica",
    cpu: "4 vCPU",
    memory: "16 GiB",
    network: "private",
    project
  }
];

console.log(JSON.stringify({
  title: "VM 인벤토리",
  summary: `${project} 범위에서 사용 중인 VM ${rows.length}대를 정리했습니다.`,
  table: {
    columns: ["name", "role", "cpu", "memory", "network", "project"],
    rows
  }
}, null, 2));
