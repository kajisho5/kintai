# kintai

勤怠管理システム（CYBER XEED 等の類似製品を調査し、小規模向け・セルフホスト可能な代替を目指す）。

- 競合調査: [docs/competitor-research.md](docs/competitor-research.md)
- `src/engine`: 労働時間集計エンジン（日次/週40h/月次、深夜、法定休日、36協定チェック、有給付与）。DB・UI非依存の純関数

```
npm install
npm test
npm run typecheck
```
