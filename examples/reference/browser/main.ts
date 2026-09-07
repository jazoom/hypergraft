import { bindTransportFeedback, startHypergraft } from "hypergraft/browser";
import "./style.css";

const { feedback } = bindTransportFeedback(document);
startHypergraft({ feedback });
