import styles from './nfl.module.css';

export default function Loading() {
  return (
    <main id="main-content" className={styles.page}>
      <div className={styles.loadingMark}>NFL EDGE</div>
      <div className={styles.loadingBoard} aria-label="Loading the current NFL market board">
        <span /><span /><span />
      </div>
      <p className={styles.loadingCopy}>Loading current moneylines, spreads, totals and props…</p>
    </main>
  );
}
