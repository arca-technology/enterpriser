import Link from "next/link";
import styles from "../system-selector.module.css";

export default function BmsPage() {
  return (
    <main className={styles.page}>
      <section className={styles.selector} aria-labelledby="bms-title">
        <p className={styles.brand}>
          ENTERPRISER <span>•</span> BMS
        </p>
        <h1 id="bms-title">BMS em preparação</h1>
        <div className={styles.options}>
          <Link className={styles.option} href="/">
            <strong>Voltar</strong>
            <span>Retornar à escolha de sistemas</span>
            <small>Início</small>
          </Link>
          <Link className={styles.option} href="/cms">
            <strong>CMS</strong>
            <span>Acessar o sistema disponível</span>
            <small>Acessar</small>
          </Link>
        </div>
      </section>
    </main>
  );
}
