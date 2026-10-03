import Link from "next/link";
import styles from "./system-selector.module.css";

export default function HomePage() {
  return (
    <main className={styles.page}>
      <section className={styles.selector} aria-labelledby="system-selector-title">
        <p className={styles.brand}>
          ENTERPRISER <span>•</span>
        </p>
        <h1 id="system-selector-title">Escolha o sistema</h1>
        <div className={styles.options}>
          <Link className={styles.option} href="/cms">
            <strong>CMS</strong>
            <span>Gestão de clientes e operações</span>
            <small>Acessar</small>
          </Link>
          <Link className={styles.option} href="/bms">
            <strong>BMS</strong>
            <span>Gestão empresarial</span>
            <small>Em preparação</small>
          </Link>
        </div>
      </section>
    </main>
  );
}
